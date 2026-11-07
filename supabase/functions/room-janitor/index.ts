// room-janitor Edge Function: deletes expired/ended rooms (cascade + cleanup_jobs via triggers),
// removes queued storage prefixes through the Storage API and verifies them empty, sweeps orphaned
// face references. Never calls AWS. Auth: header x-janitor-secret is checked against private.janitor_config via janitor_secret_ok (pg_net sends it from inside the database).
import { createClient } from 'npm:@supabase/supabase-js@2';

import { runJanitor, type CleanupJob, type JanitorStore, type StoredObject } from './core.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const provided = req.headers.get('x-janitor-secret') ?? '';
  if (provided.length < 32 || provided.length > 128) return json(401, { error: 'unauthorized' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: ok } = await admin.rpc('janitor_secret_ok', { p_secret: provided });
  if (ok !== true) return json(401, { error: 'unauthorized' });

  // Recursive listing. Storage list() returns one folder level; folders have id === null.
  async function listDir(bucket: string, dir: string, out: StoredObject[]) {
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await admin.storage.from(bucket).list(dir, { limit: 100, offset });
      if (error) throw error;
      for (const e of data ?? []) {
        const path = dir ? `${dir}/${e.name}` : e.name;
        if (e.id === null) await listDir(bucket, path, out);
        else out.push({ name: path, createdAt: e.created_at ?? new Date(0).toISOString() });
      }
      if (!data || data.length < 100) break;
    }
  }

  const store: JanitorStore = {
    async deleteExpiredRooms(limit) {
      const nowIso = new Date().toISOString();
      const { data, error } = await admin.from('rooms').select('id').or(`expires_at.lte.${nowIso},deleted_at.not.is.null`).limit(limit);
      if (error) throw error;
      const ids = (data ?? []).map((r) => r.id);
      if (ids.length === 0) return [];
      const { error: delErr } = await admin.from('rooms').delete().in('id', ids);
      if (delErr) throw delErr;
      return ids;
    },
    async claimCleanupJobs(limit) {
      const { data, error } = await admin.from('cleanup_jobs').select('id, bucket, prefix, created_at, attempts').is('verified_empty_at', null).order('attempts').order('created_at').limit(limit);
      if (error) throw error;
      return (data ?? []) as CleanupJob[];
    },
    async listObjects(bucket, prefix) {
      const out: StoredObject[] = [];
      if (prefix.endsWith('/')) {
        await listDir(bucket, prefix.slice(0, -1), out);
      } else {
        const i = prefix.lastIndexOf('/');
        const dir = i >= 0 ? prefix.slice(0, i) : '';
        const base = prefix.slice(i + 1);
        const { data, error } = await admin.storage.from(bucket).list(dir, { limit: 100, search: base });
        if (error) throw error;
        for (const e of data ?? []) if (e.name === base && e.id !== null) out.push({ name: prefix, createdAt: e.created_at ?? new Date(0).toISOString() });
      }
      return out;
    },
    async removeObjects(bucket, names) {
      for (let i = 0; i < names.length; i += 100) {
        const { error } = await admin.storage.from(bucket).remove(names.slice(i, i + 100));
        if (error) throw error;
      }
    },
    async finishCleanup(id, r) {
      const { data: cur } = await admin.from('cleanup_jobs').select('attempts').eq('id', id).maybeSingle();
      await admin.from('cleanup_jobs').update({
        attempts: (cur?.attempts ?? 0) + (r.verifiedEmpty ? 0 : 1),
        last_error: r.error,
        verified_empty_at: r.verifiedEmpty ? new Date().toISOString() : null,
      }).eq('id', id);
    },
    async activeFaceRefPaths() {
      const { data, error } = await admin.from('face_enrollments').select('ref_path');
      if (error) throw error;
      return new Set((data ?? []).map((e) => e.ref_path));
    },
    async listAllObjects(bucket) {
      const out: StoredObject[] = [];
      await listDir(bucket, '', out);
      return out;
    },
  };

  try {
    const summary = await runJanitor(store, {
      now: new Date(),
      roomLimit: 50,
      jobLimit: 50,
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    });
    return json(200, summary);
  } catch {
    console.log(JSON.stringify({ event: 'janitor_failed' }));
    return json(500, { error: 'janitor_failed' });
  }
});
