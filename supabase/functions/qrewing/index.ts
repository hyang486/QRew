// qrewing Edge Function (contract: planning/QREWING_AI_SPEC_EN.md sections 2 and 7.2). Deployed with verify_jwt=false.
// verify_jwt=false with the in-function JWT check, like face-match. Actions: probe, triage, recap, match.
// Secret ANTHROPIC_API_KEY is set by the human; it is never logged or returned. Without it every call except an
// unscoped probe after auth returns 503 ai_not_configured before any DB write, so deploying makes no AI calls.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
// Order: 405 (not POST) -> 401 (no valid user JWT) -> core.handle (400 -> 503 -> 403 not_member -> 403 ai_off -> action).
import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

import { handle, type Model, type Msg, type QrewingStore, type RecapRow, type StoredMatch, TRIAGE_MODEL_SKIP_REASON } from './core.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const log = (event: string, fields: Record<string, string | number | boolean>) => console.log(JSON.stringify({ event, ...fields }));

/** Anthropic adapter: structured output via output_config.format; no thinking field, no sampling params. */
function createModel(apiKey: string): Model {
  // maxRetries 1 = one retry on 429/5xx/connection errors (SDK default backoff).
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
  return {
    async call(req) {
      const res = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        stopReason: res.stop_reason ?? null,
        text,
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
      };
    },
  };
}

const MSG_COLS = 'id, room_id, kind, sender_id, body, created_at';
type MsgRow = { id: string; room_id: string; kind: string; sender_id: string | null; body: string | null; created_at: string };
const toMsg = (r: MsgRow): Msg => ({ id: r.id, roomId: r.room_id, kind: r.kind, senderId: r.sender_id, body: r.body, createdAt: r.created_at });

const RECAP_COLS = 'state, title, summary, highlights, created_at, updated_at, refreshed_at';
type RecapDb = {
  state: RecapRow['state'];
  title: string | null;
  summary: string | null;
  highlights: string[] | null;
  created_at: string;
  updated_at: string;
  refreshed_at: string | null;
};
const toRecap = (r: RecapDb | null): RecapRow | null =>
  r && {
    state: r.state,
    title: r.title,
    summary: r.summary,
    highlights: r.highlights,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    refreshedAt: r.refreshed_at,
  };

/** Throws on a PostgREST error so core never mistakes a failed read for "no rows". */
// deno-lint-ignore no-explicit-any
function must(res: { data: any; error: { message: string; code?: string } | null }, what: string): any {
  if (res.error) {
    log('db_error', { what, code: res.error.code ?? '' });
    throw new Error(`db_error:${what}`);
  }
  return res.data;
}

// deno-lint-ignore no-explicit-any
function createStore(admin: any): QrewingStore {
  return {
    async room(roomId) {
      const r = must(
        await admin
          .from('rooms')
          .select('id, name, type, host_id, expires_at, deleted_at, grace_until, place_name, starts_at')
          .eq('id', roomId)
          .maybeSingle(),
        'room',
      );
      return r
        ? {
            id: r.id,
            name: r.name,
            type: r.type,
            hostId: r.host_id,
            expiresAt: r.expires_at,
            deletedAt: r.deleted_at,
            graceUntil: r.grace_until,
            placeName: r.place_name,
            startsAt: r.starts_at,
          }
        : null;
    },
    async isMember(roomId, userId) {
      const r = must(await admin.from('room_members').select('user_id').eq('room_id', roomId).eq('user_id', userId).maybeSingle(), 'member');
      return !!r;
    },
    async aiEnabled(roomId) {
      const r = must(await admin.from('qrewing_rooms').select('ai_enabled').eq('room_id', roomId).maybeSingle(), 'ai_enabled');
      return r?.ai_enabled === true;
    },
    async consents(roomId) {
      const rows = must(await admin.from('qrewing_members').select('user_id, ai_ok_at, mute_small_talk').eq('room_id', roomId), 'consents');
      return new Map(
        (rows ?? []).map((r: { user_id: string; ai_ok_at: string | null; mute_small_talk: boolean }) => [
          r.user_id,
          { aiOk: r.ai_ok_at !== null, mute: r.mute_small_talk },
        ]),
      );
    },
    async memberIds(roomId) {
      const rows = must(await admin.from('room_members').select('user_id').eq('room_id', roomId), 'members');
      return (rows ?? []).map((r: { user_id: string }) => r.user_id);
    },
    async displayNames(userIds) {
      if (userIds.length === 0) return new Map();
      const rows = must(await admin.from('profiles').select('id, display_name').in('id', userIds), 'names');
      return new Map((rows ?? []).map((r: { id: string; display_name: string }) => [r.id, r.display_name]));
    },

    async messagesByIds(ids) {
      const rows = must(await admin.from('messages').select(MSG_COLS).in('id', ids), 'messages_ids');
      return (rows ?? []).map(toMsg);
    },
    async textBefore(roomId, before, limit) {
      const rows = must(
        await admin.from('messages').select(MSG_COLS).eq('room_id', roomId).eq('kind', 'text').lt('created_at', before)
          .order('created_at', { ascending: false }).limit(limit),
        'messages_before',
      );
      return (rows ?? []).map(toMsg);
    },
    async latestText(roomId, limit) {
      const rows = must(
        await admin.from('messages').select(MSG_COLS).eq('room_id', roomId).eq('kind', 'text')
          .order('created_at', { ascending: false }).limit(limit),
        'messages_latest',
      );
      return (rows ?? []).map(toMsg);
    },
    async textAfter(roomId, after, limit) {
      const rows = must(
        await admin.from('messages').select(MSG_COLS).eq('room_id', roomId).eq('kind', 'text').gt('created_at', after)
          .order('created_at', { ascending: false }).limit(limit),
        'messages_after',
      );
      return (rows ?? []).map(toMsg);
    },
    async mediaCounts(roomId) {
      const count = async (kind: string) => {
        const res = await admin.from('media').select('id', { count: 'exact', head: true }).eq('room_id', roomId).eq('kind', kind).eq('status', 'ready');
        must(res, 'media_count');
        return res.count ?? 0;
      };
      const [photos, videos] = await Promise.all([count('photo'), count('video')]);
      return { photos, videos };
    },

    async triageRows(messageIds) {
      if (messageIds.length === 0) return [];
      const rows = must(
        await admin.from('message_triage').select('message_id, state, important, reason, updated_at').in('message_id', messageIds),
        'triage_rows',
      );
      return (rows ?? []).map((r: { message_id: string; state: 'pending' | 'done' | 'skipped'; important: boolean | null; reason: string | null; updated_at: string }) => ({
        messageId: r.message_id,
        state: r.state,
        important: r.important,
        reason: r.reason,
        updatedAt: r.updated_at,
      }));
    },
    async triageCountSince(roomId, since) {
      const res = await admin
        .from('message_triage')
        .select('message_id', { count: 'exact', head: true })
        .eq('room_id', roomId)
        .eq('source', 'model')
        // M2: a skipped row counts only when the model was asked about it (reason = the model-skip marker).
        .or(`state.neq.skipped,reason.eq.${TRIAGE_MODEL_SKIP_REASON}`)
        .gte('created_at', since);
      must(res, 'triage_count');
      return res.count ?? 0;
    },
    async skipTriage(roomId, messageIds) {
      must(
        await admin
          .from('message_triage')
          .upsert(messageIds.map((id) => ({ message_id: id, room_id: roomId, state: 'skipped', important: false })), {
            onConflict: 'message_id',
            ignoreDuplicates: true,
          }),
        'triage_skip',
      );
    },
    async claimTriage(roomId, messageIds, staleBefore) {
      // Insert ... on conflict do nothing returning: only rows this call created come back.
      const inserted = must(
        await admin
          .from('message_triage')
          .upsert(messageIds.map((id) => ({ message_id: id, room_id: roomId, state: 'pending' })), {
            onConflict: 'message_id',
            ignoreDuplicates: true,
          })
          .select('message_id'),
        'triage_claim',
      );
      const mine = new Set<string>((inserted ?? []).map((r: { message_id: string }) => r.message_id));
      const rest = messageIds.filter((id) => !mine.has(id));
      if (rest.length > 0) {
        // Retake claims whose caller died. The row lock makes the updated_at test a per-row race one caller wins.
        const retaken = must(
          await admin
            .from('message_triage')
            .update({ updated_at: new Date().toISOString() })
            .in('message_id', rest)
            .eq('state', 'pending')
            .lt('updated_at', staleBefore)
            .select('message_id'),
          'triage_retake',
        );
        for (const r of retaken ?? []) mine.add(r.message_id);
      }
      return messageIds.filter((id) => mine.has(id));
    },
    async finishTriage(messageId, r) {
      must(
        await admin.from('message_triage').update({ state: r.state, important: r.important, reason: r.reason, source: r.source }).eq('message_id', messageId).eq('state', 'pending'),
        'triage_finish',
      );
    },

    async recap(roomId) {
      return toRecap(must(await admin.from('room_recaps').select(RECAP_COLS).eq('room_id', roomId).maybeSingle(), 'recap'));
    },
    async claimRecap(roomId, staleBefore) {
      const inserted = must(
        await admin
          .from('room_recaps')
          .upsert({ room_id: roomId, state: 'pending' }, { onConflict: 'room_id', ignoreDuplicates: true })
          .select('room_id'),
        'recap_claim',
      );
      if ((inserted ?? []).length > 0) return true;
      const now = new Date().toISOString();
      // S2: a pending row whose caller died is retaken once; refreshed_at marks the retry as spent.
      const stale = must(
        await admin
          .from('room_recaps')
          .update({ created_at: now, refreshed_at: now })
          .eq('room_id', roomId)
          .eq('state', 'pending')
          .lt('updated_at', staleBefore)
          .is('refreshed_at', null)
          .select('room_id'),
        'recap_retake_stale',
      );
      if ((stale ?? []).length > 0) return true;
      // F1: a failed row is retried once; refreshed_at marks the retry as spent. The row lock makes it one winner.
      const retried = must(
        await admin
          .from('room_recaps')
          .update({ state: 'pending', title: null, summary: null, highlights: null, created_at: now, refreshed_at: now })
          .eq('room_id', roomId)
          .eq('state', 'failed')
          .is('refreshed_at', null)
          .select('room_id'),
        'recap_retake_failed',
      );
      return (retried ?? []).length > 0;
    },
    async finishRecap(roomId, r) {
      const patch = r.state === 'done'
        ? { state: 'done', title: r.title, summary: r.summary, highlights: r.highlights, refreshed_at: null }
        : { state: 'failed', title: null, summary: null, highlights: null };
      return toRecap(
        must(await admin.from('room_recaps').update(patch).eq('room_id', roomId).eq('state', 'pending').select(RECAP_COLS).maybeSingle(), 'recap_finish'),
      );
    },
    async claimRecapRefresh(roomId) {
      const rows = must(
        await admin
          .from('room_recaps')
          .update({ refreshed_at: new Date().toISOString() })
          .eq('room_id', roomId)
          .eq('state', 'done')
          .is('refreshed_at', null)
          .select('room_id'),
        'recap_refresh_claim',
      );
      return (rows ?? []).length > 0;
    },
    async saveRecapRefresh(roomId, r) {
      return toRecap(
        must(
          await admin
            .from('room_recaps')
            .update({ title: r.title, summary: r.summary, highlights: r.highlights })
            .eq('room_id', roomId)
            .eq('state', 'done')
            .select(RECAP_COLS)
            .maybeSingle(),
          'recap_refresh_save',
        ),
      );
    },

    async entryQuestions(roomId) {
      const rows = must(
        await admin.from('entry_questions').select('id, position, kind, prompt').eq('room_id', roomId).order('position'),
        'entry_questions',
      );
      return (rows ?? []).map((r: { id: string; position: number; kind: 'short' | 'long' | 'links'; prompt: string }) => ({
        id: r.id,
        position: r.position,
        kind: r.kind,
        prompt: r.prompt,
      }));
    },
    async entryProfiles(roomId) {
      const rows = must(
        await admin.from('entry_profiles').select('user_id, headline, interests, looking_for, answers, updated_at').eq('room_id', roomId),
        'entries',
      );
      return (rows ?? []).map((r: { user_id: string; headline: string; interests: string; looking_for: string; answers: unknown; updated_at: string }) => ({
        userId: r.user_id,
        headline: r.headline,
        interests: r.interests,
        lookingFor: r.looking_for,
        answers: r.answers && typeof r.answers === 'object' && !Array.isArray(r.answers) ? (r.answers as Record<string, unknown>) : {},
        updatedAt: r.updated_at,
      }));
    },
    async match(roomId, userId) {
      const r = must(
        await admin.from('qrewing_matches').select('input_hash, matches, created_at').eq('room_id', roomId).eq('user_id', userId).maybeSingle(),
        'match',
      );
      return r ? { inputHash: r.input_hash, matches: Array.isArray(r.matches) ? r.matches : [], createdAt: r.created_at } : null;
    },
    async claimMatch(roomId, userId, seenHash, claim) {
      const now = new Date().toISOString();
      const rows = seenHash === null
        ? must(
          await admin
            .from('qrewing_matches')
            .upsert({ room_id: roomId, user_id: userId, input_hash: claim, matches: [], created_at: now }, {
              onConflict: 'room_id,user_id',
              ignoreDuplicates: true,
            })
            .select('room_id'),
          'match_claim_insert',
        )
        : must(
          await admin
            .from('qrewing_matches')
            .update({ input_hash: claim, created_at: now })
            .eq('room_id', roomId)
            .eq('user_id', userId)
            .eq('input_hash', seenHash)
            .select('room_id'),
          'match_claim',
        );
      return (rows ?? []).length > 0;
    },
    async saveMatch(roomId, userId, claim, inputHash, matches: StoredMatch[]) {
      const createdAt = new Date().toISOString();
      must(
        await admin
          .from('qrewing_matches')
          .update({ input_hash: inputHash, matches, created_at: createdAt })
          .eq('room_id', roomId)
          .eq('user_id', userId)
          .eq('input_hash', claim),
        'match_save',
      );
      return createdAt;
    },
    async failMatch(roomId, userId, claim, marker) {
      must(
        await admin
          .from('qrewing_matches')
          .update({ input_hash: marker, created_at: new Date().toISOString() })
          .eq('room_id', roomId)
          .eq('user_id', userId)
          .eq('input_hash', claim),
        'match_fail',
      );
    },

    async logUsage(roomId, action, model, inputTokens, outputTokens, userId) {
      must(
        await admin.rpc('log_qrewing_usage', {
          p_room_id: roomId,
          p_action: action,
          p_model: model,
          p_input_tokens: inputTokens,
          p_output_tokens: outputTokens,
          ...(userId ? { p_user_id: userId } : {}),
        }),
        'usage',
      );
    },
    async usageCountSince(roomId, action, since, userId) {
      const n = must(
        await admin.rpc('qrewing_usage_count', { p_room_id: roomId, p_action: action, p_since: since, ...(userId ? { p_user_id: userId } : {}) }),
        'usage_count',
      );
      return typeof n === 'number' ? n : 0;
    },
    async roomExtras(roomId) {
      // Both reads at once; must() in the old order, so the same error is logged and thrown.
      const [roomRes, labelRes] = await Promise.all([
        admin.from('rooms').select('activity_state, route').eq('id', roomId).maybeSingle(),
        admin.from('status_definitions').select('label').eq('room_id', roomId).order('sort'),
      ]);
      const r = must(roomRes, 'room_extras');
      const labels = must(labelRes, 'status_labels');
      return {
        activityState: r?.activity_state ?? 'idle',
        route: Array.isArray(r?.route) ? r.route : [],
        statusLabels: (labels ?? []).map((x: { label: string }) => x.label),
      };
    },
  };
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // Pass the token to getUser explicitly (face-match note, 2026-11-06).
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return json(401, { error: 'unauthorized' });
  // L8: env, client setup and getUser are inside the try, so a throw there is a logged 500, not an unhandled error.
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
    const { data: userData, error: userErr } = await asUser.auth.getUser(token);
    if (userErr || !userData.user) return json(401, { error: 'unauthorized' });
    const authMs = Date.now() - startedAt;

    const rawBody = await req.json().catch(() => null);
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const reply = await handle({ store: createStore(admin), model: apiKey ? createModel(apiKey) : null, log, startedAt, authMs }, userData.user.id, rawBody);
    return json(reply.status, reply.body);
  } catch (e) {
    // DB errors (logged by must) and anything unexpected: no detail to the client.
    log('internal_error', { kind: e instanceof Error ? e.message.slice(0, 40) : 'unknown' });
    return json(500, { error: 'internal' });
  }
});
