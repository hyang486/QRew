// delete-account Edge Function (deployed v1 on 2026-11-05, verify_jwt=false; depends on migration 0021).
// The signed-in user (host account or guest) deletes their own account. There is no other target:
// the user id comes only from the caller's verified JWT.
//   1. public.prepare_account_deletion(uid) (service role): ends hosted rooms, queues Storage cleanup
//      for the user's media in other rooms and their avatar folder, stops location sharing.
//   2. auth.admin.deleteUser(uid): the database cascade removes profile, memberships and the rest
//      (see the migration header). The room-janitor then deletes the queued Storage objects.
// Both steps are safe to repeat: if step 2 fails, the client may call again.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from 'npm:@supabase/supabase-js@2';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

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

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const { data: prepared, error: prepErr } = await admin.rpc('prepare_account_deletion', { p_user_id: userId });
  if (prepErr) {
    console.error('prepare_account_deletion failed', prepErr.code);
    return json(500, { error: 'prepare_failed' });
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    console.error('deleteUser failed', delErr.status);
    return json(500, { error: 'delete_failed' });
  }

  return json(200, { deleted: true, ...(prepared as Record<string, unknown>) });
});
