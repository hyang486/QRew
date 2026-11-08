// face-match Edge Function (deployed 2026-11-06, verify_jwt=false). FACE_MATCH_ENABLED is OFF by default; AWS is called
// only while it is exactly 'true'. Live test with rights-cleared photos: PASS 2026-11-06, switch OFF again afterwards.
// A signed-in member calls it to process queued face_jobs for THEIR OWN enrollments.
// Secrets (set by the human, never logged): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION.
// Order: 405 (not POST) -> 401 (no valid user JWT) -> 503 switch -> 503 AWS config -> 400 bad body -> probe 200.
// FM-Q A′-2 (not deployed yet): compares the temporary detect copy {room}/{media}/detect/{enrollment}.jpg uploaded
// by the member's device (see ../_shared/detect.ts), falls back to the preview, and deletes the copy in finally.
// Switch: FACE_MATCH_ENABLED must be exactly 'true', otherwise 503 before any AWS or job work.
// Matching runs only when an enrolled member's app calls this function (no background worker yet).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { DEFAULT_SIMILARITY_THRESHOLD, MAX_ATTEMPTS, processBatch, type FaceStore, type Job } from './core.ts';
import { createRekognitionProvider } from './rekognition.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const BATCH_LIMIT = 10;
/** FM-Q A′-2: the most job ids one call may name. The client sends small batches so each detect copy lives one call. */
const MAX_JOB_IDS = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Body: {} (legacy: up to BATCH_LIMIT of my queued jobs), {probe: true} (switch/config check only, no job work,
 * so the app uploads no detect copy while matching is off), or {jobIds: [...]} (only these jobs, still only mine).
 */
function parseBody(raw: unknown): { probe: boolean; jobIds: string[] | null } | null {
  if (raw === null || typeof raw !== 'object') return { probe: false, jobIds: null };
  const b = raw as { probe?: unknown; jobIds?: unknown };
  if (b.probe === true) return { probe: true, jobIds: null };
  if (b.jobIds === undefined) return { probe: false, jobIds: null };
  if (!Array.isArray(b.jobIds) || b.jobIds.length === 0 || b.jobIds.length > MAX_JOB_IDS) return null;
  if (!b.jobIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) return null;
  return { probe: false, jobIds: [...new Set(b.jobIds as string[])] };
}
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
  const body = parseBody(await req.json().catch(() => null));
  if (!body) return json(400, { error: 'bad_request' });
  if (body.probe) return json(200, { enabled: true });
  const jobIds = body.jobIds;

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const store: FaceStore = {
    async claimJobs(limit) {
      // Only jobs of the caller's own enrollments. Stale 'running' jobs (crashed worker) are retaken after 5 minutes.
      const { data: enr } = await admin.from('face_enrollments').select('id').eq('user_id', userId);
      const ids = (enr ?? []).map((e) => e.id);
      if (ids.length === 0) return [];
      const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
      let q = admin
        .from('face_jobs')
        .select('id, enrollment_id, media_id, attempts')
        .in('enrollment_id', ids)
        // FM2: a job that crashes the worker every time is retaken at most MAX_ATTEMPTS times (one paid call each).
        .lt('attempts', MAX_ATTEMPTS)
        .or(`status.eq.queued,and(status.eq.running,updated_at.lt.${cutoff})`);
      if (jobIds) q = q.in('id', jobIds);
      const { data: cand } = await q.order('created_at').limit(limit);
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
      const { data } = await admin.from('face_enrollments').select('id, ref_path, room_id').eq('id', id).maybeSingle();
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
    async getPhoto(mediaId) {
      const { data } = await admin.from('media').select('room_id, preview_path, original_path, status, kind').eq('id', mediaId).maybeSingle();
      if (!data || data.kind !== 'photo' || data.status !== 'ready') return null;
      return { room_id: data.room_id, fallback_path: data.preview_path ?? data.original_path };
    },
    async removeObject(bucket, path) {
      // Storage API delete (service role): removes the stored file and its row. Missing objects are no error.
      const { error } = await admin.storage.from(bucket).remove([path]);
      if (error) throw error;
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
