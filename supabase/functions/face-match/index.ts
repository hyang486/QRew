// face-match Edge Function (deployed 2026-11-06, verify_jwt=false). FACE_MATCH_ENABLED is OFF by default; AWS is called
// only while it is exactly 'true'. Live test with rights-cleared photos: PASS 2026-11-06, switch OFF again afterwards.
// A signed-in member calls it to process queued face_jobs for THEIR OWN enrollments.
// Secrets (set by the human, never logged): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION.
// Order: 405 (not POST) -> 401 (no valid user JWT) -> 503 switch -> 503 AWS config.
// Switch: FACE_MATCH_ENABLED must be exactly 'true', otherwise 503 before any AWS or job work.
// Matching runs only when an enrolled member's app calls this function (no background worker yet).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { DEFAULT_SIMILARITY_THRESHOLD, MAX_ATTEMPTS, processBatch, type FaceStore, type Job } from './core.ts';
import { createRekognitionProvider } from './rekognition.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const BATCH_LIMIT = 10;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // FM1: authenticate first, so an unauthenticated caller learns nothing beyond 401.
  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('authorization') ?? '';
  // Pass the token to getUser explicitly. A lowercase 'authorization' key in global.headers is overridden by
  // supabase-js's own Authorization header (the API key), so getUser() rejected valid user tokens (2026-11-06).
  const token = /^Bearer\s+(\S+)$/i.exec(authHeader)?.[1];
  if (!token) return json(401, { error: 'unauthorized' });
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await asUser.auth.getUser(token);
  if (userErr || !userData.user) return json(401, { error: 'unauthorized' });
  const userId = userData.user.id;

  // Server switch: on only during the rights-cleared test, off otherwise (see docs/aws-rekognition-human-steps.md).
  if (Deno.env.get('FACE_MATCH_ENABLED') !== 'true') return json(503, { error: 'face_match_disabled' });
  const accessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = Deno.env.get('AWS_REGION');
  if (!accessKeyId || !secretAccessKey || !region) return json(503, { error: 'face_provider_not_configured' });

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const store: FaceStore = {
    async claimJobs(limit) {
      // Only jobs of the caller's own enrollments. Stale 'running' jobs (crashed worker) are retaken after 5 minutes.
      const { data: enr } = await admin.from('face_enrollments').select('id').eq('user_id', userId);
      const ids = (enr ?? []).map((e) => e.id);
      if (ids.length === 0) return [];
      const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: cand } = await admin
        .from('face_jobs')
        .select('id, enrollment_id, media_id, attempts')
        .in('enrollment_id', ids)
        // FM2: a job that crashes the worker every time is retaken at most MAX_ATTEMPTS times (one paid call each).
        .lt('attempts', MAX_ATTEMPTS)
        .or(`status.eq.queued,and(status.eq.running,updated_at.lt.${cutoff})`)
        .order('created_at')
        .limit(limit);
      const claimed: Job[] = [];
      for (const c of cand ?? []) {
        // Conditional update = per-row atomic claim; a concurrent worker loses the race.
        const { data: won } = await admin
          .from('face_jobs')
          .update({ status: 'running', attempts: c.attempts + 1, updated_at: new Date().toISOString() })
          .eq('id', c.id)
          .eq('attempts', c.attempts)
          .select('id, enrollment_id, media_id, attempts')
          .maybeSingle();
        if (won) claimed.push({ ...won, attempts: c.attempts }); // attempts BEFORE this run, as core expects
      }
      return claimed;
    },
    async getEnrollment(id) {
      const { data } = await admin.from('face_enrollments').select('id, ref_path').eq('id', id).maybeSingle();
      return data;
    },
    async enrollmentAccess(enrollmentId) {
      const { data: e } = await admin.from('face_enrollments').select('room_id, user_id').eq('id', enrollmentId).maybeSingle();
      if (!e) return 'not_member';
      const { data: room } = await admin.from('rooms').select('deleted_at, expires_at').eq('id', e.room_id).maybeSingle();
      if (!room || room.deleted_at !== null || new Date(room.expires_at).getTime() <= Date.now()) return 'room_closed';
      const { data: m } = await admin.from('room_members').select('user_id').eq('room_id', e.room_id).eq('user_id', e.user_id).maybeSingle();
      return m ? 'ok' : 'not_member';
    },
    async getPhotoPath(mediaId) {
      const { data } = await admin.from('media').select('preview_path, original_path, status, kind').eq('id', mediaId).maybeSingle();
      if (!data || data.kind !== 'photo' || data.status !== 'ready') return null;
      return data.preview_path ?? data.original_path;
    },
    async download(bucket, path) {
      const { data, error } = await admin.storage.from(bucket).download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async saveMatch(enrollmentId, mediaId, r) {
      // face_matches.enrollment_id has an FK to face_enrollments: if the enrollment was deleted
      // (leave, expiry, re-enroll), this insert fails with 23503 and nothing is created.
      const { error } = await admin
        .from('face_matches')
        .upsert({ enrollment_id: enrollmentId, media_id: mediaId, similarity: r.similarity, matched: r.matched }, { onConflict: 'enrollment_id,media_id', ignoreDuplicates: false });
      if (error?.code === '23503') return 'stale';
      if (error) throw error;
      return 'saved';
    },
    async finishJob(jobId, status, error) {
      await admin.from('face_jobs').update({ status, last_error: error, updated_at: new Date().toISOString() }).eq('id', jobId);
    },
  };

  const provider = createRekognitionProvider({ accessKeyId, secretAccessKey, region, similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD - 10 });
  const summary = await processBatch(store, provider, {
    limit: BATCH_LIMIT,
    threshold: DEFAULT_SIMILARITY_THRESHOLD,
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  });
  return json(200, summary);
});
