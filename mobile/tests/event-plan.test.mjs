// Run: npm test. Qrewing AI event features: entry limits, consent/entry gates, mentions, Mute small talk.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collapseSmallTalk,
  createTriageBatcher,
  chatGates,
  linksByUser,
  mentionsName,
  needsDisclosure,
  needsEntry,
  newestMs,
  nextLoadedOnce,
  pickBanner,
  staysVisible,
  validateEntry,
} from '../src/features/event/event-plan.ts';
import { allowedQrewingCalls, classifyQrewingError, isQrewingError } from '../src/features/event/qrewing-plan.ts';

const entry = (o = {}) => ({ headline: 'CS junior', interests: '', lookingFor: '', links: [], ...o });

test('validateEntry: trims and drops empty links', () => {
  const r = validateEntry(entry({ headline: '  CS junior ', links: [' https://a.dev ', '  '] }));
  assert.deepEqual(r, { value: { headline: 'CS junior', interests: '', lookingFor: '', links: ['https://a.dev'] } });
});

test('validateEntry: spec 1.3 limits', () => {
  assert.deepEqual(validateEntry(entry({ headline: '   ' })), { problem: 'headlineRequired' });
  assert.ok('value' in validateEntry(entry({ headline: 'a'.repeat(80) })));
  assert.deepEqual(validateEntry(entry({ headline: 'a'.repeat(81) })), { problem: 'headlineTooLong' });
  assert.deepEqual(validateEntry(entry({ interests: 'a'.repeat(301) })), { problem: 'interestsTooLong' });
  assert.deepEqual(validateEntry(entry({ lookingFor: 'a'.repeat(301) })), { problem: 'lookingForTooLong' });
  const four = ['https://a.dev', 'https://b.dev', 'https://c.dev', 'https://d.dev'];
  assert.deepEqual(validateEntry(entry({ links: four })), { problem: 'tooManyLinks' });
  assert.deepEqual(validateEntry(entry({ links: ['http://a.dev'] })), { problem: 'linkInvalid' });
  assert.deepEqual(validateEntry(entry({ links: ['https://'] })), { problem: 'linkInvalid' });
  assert.deepEqual(validateEntry(entry({ links: ['https://' + 'a'.repeat(193)] })), { problem: 'linkInvalid' });
  assert.ok('value' in validateEntry(entry({ links: ['https://' + 'a'.repeat(192)] })));
});

test('needsDisclosure: only in an AI room before the member answered', () => {
  assert.equal(needsDisclosure(false, null), false);
  assert.equal(needsDisclosure(true, null), true);
  assert.equal(needsDisclosure(true, { aiOk: false, mute: false }), false);
  assert.equal(needsDisclosure(true, { aiOk: true, mute: false }), false);
});

test('needsEntry: event rooms with entry_required, once we know there is no profile', () => {
  assert.equal(needsEntry(true, 'event', false), true);
  assert.equal(needsEntry(true, 'event', null), false);
  assert.equal(needsEntry(true, 'event', true), false);
  assert.equal(needsEntry(true, 'sports', false), false);
  assert.equal(needsEntry(false, 'event', false), false);
});

test('mentionsName: "@" + full name or first word, word-bounded, case-insensitive, NFC', () => {
  assert.equal(mentionsName('@jay check this', 'Jay'), true);
  assert.equal(mentionsName('hey @JAY, where are you?', 'Jay'), true);
  assert.equal(mentionsName('hey Jay, where are you?', 'Jay'), false, 'bare name is not a mention');
  assert.equal(mentionsName('@Bobby is here', 'Bob'), false, 'longer name');
  assert.equal(mentionsName('mail x@bob.com', 'Bob'), false, 'email');
  assert.equal(mentionsName('@@bob', 'Bob'), false);
  assert.equal(mentionsName('(@bob)', 'Bob'), true);
  assert.equal(mentionsName('@bob.', 'Bob'), true, 'sentence end');
  assert.equal(mentionsName('Ask @Mina Park', 'Mina Park'), true, 'full name');
  assert.equal(mentionsName('Ask @mina', 'Mina  Park'), true, 'first word');
  assert.equal(mentionsName('Ask @Park', 'Mina Park'), false, 'last word alone');
  assert.equal(mentionsName('@민지 어디야', '민지'), true);
  assert.equal(mentionsName('@민지야', '민지'), false);
  // NFD "é" (e + U+0301) in the body matches the NFC name, and the reverse.
  assert.equal(mentionsName('@Jose\u0301 hi', 'Jos\u00e9'), true);
  assert.equal(mentionsName('@Jos\u00e9 hi', 'Jose\u0301'), true);
  assert.equal(mentionsName('@a.b', 'a.b'), true);
  assert.equal(mentionsName('@axb', 'a.b'), false);
  assert.equal(mentionsName('@J is here', 'J'), false, 'under 2 characters');
  assert.equal(mentionsName('@J is here', 'J Lee'), false, 'first word under 2 characters');
  assert.equal(mentionsName('@everyone', 'Jay'), false);
  assert.equal(mentionsName(null, 'Jay'), false);
  assert.equal(mentionsName('@Jay', ''), false);
});

const ME = 'u-me';
const msg = (id, o = {}) => ({ id, kind: 'text', sender_id: 'u-other', body: 'hi', ...o });

test('staysVisible: only others\' text judged done and not important can hide', () => {
  const flags = new Map([
    ['done-true', { state: 'done', important: true, reason: 'Room moved' }],
    ['done-false', { state: 'done', important: false, reason: null }],
    ['pending', { state: 'pending', important: false, reason: null }],
    ['skipped', { state: 'skipped', important: false, reason: null }],
  ]);
  assert.equal(staysVisible(msg('done-false'), ME, 'Jay', flags), false, 'done + not important hides');
  assert.equal(staysVisible(msg('done-true'), ME, 'Jay', flags), true, 'done + important stays');
  assert.equal(staysVisible(msg('no-flag'), ME, 'Jay', flags), true, 'never judged stays');
  assert.equal(staysVisible(msg('pending'), ME, 'Jay', flags), true, 'pending stays');
  assert.equal(staysVisible(msg('skipped'), ME, 'Jay', flags), true, 'skipped (not consented, cap) stays');
  assert.equal(staysVisible(msg('done-false', { body: '@Jay come here' }), ME, 'Jay', flags), true, 'mention stays');
  assert.equal(staysVisible(msg('done-false', { body: 'Jay come here' }), ME, 'Jay', flags), false, 'bare name hides');
  assert.equal(staysVisible(msg('done-false', { body: '@Jay come here' }), ME, 'Sam', flags), false, 'mention of someone else hides');
  assert.equal(staysVisible(msg('done-false', { sender_id: ME }), ME, 'Jay', flags), true);
  assert.equal(staysVisible(msg('done-false', { kind: 'arrival' }), ME, 'Jay', flags), true);
  assert.equal(staysVisible(msg('done-false', { kind: 'emergency' }), ME, 'Jay', flags), true);
});

test('collapseSmallTalk: runs collapse into one row and can expand', () => {
  const items = [msg('a'), msg('b'), msg('c', { sender_id: ME }), msg('d'), msg('e', { sender_id: ME })];
  const visible = (m) => m.sender_id === ME;
  const rows = collapseSmallTalk(items, visible, new Set());
  assert.deepEqual(
    rows.map((r) => (r.type === 'hidden' ? `${r.key}:${r.ids.join(',')}` : r.item.id)),
    ['hidden-b:a,b', 'c', 'hidden-d:d', 'e'],
  );
  const open = collapseSmallTalk(items, visible, new Set(['hidden-b']));
  assert.deepEqual(open.map((r) => (r.type === 'hidden' ? r.key : r.item.id)), ['a', 'b', 'c', 'hidden-d', 'e']);
  // A new message arriving at the front of a newest-first list keeps the run key.
  const more = collapseSmallTalk([msg('z'), ...items], visible, new Set(['hidden-b']));
  assert.deepEqual(more.map((r) => (r.type === 'hidden' ? r.key : r.item.id)), ['z', 'a', 'b', 'c', 'hidden-d', 'e']);
});

function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn) => {
      const h = next++;
      timers.set(h, fn);
      return h;
    },
    clearTimer: (h) => timers.delete(h),
    fire: () => {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((fn) => fn());
    },
    count: () => timers.size,
  };
}

test('createTriageBatcher: up to 5 per batch, flush after the delay, no duplicates', () => {
  const t = fakeTimers();
  const batches = [];
  const b = createTriageBatcher({ flush: (ids) => batches.push(ids), setTimer: t.setTimer, clearTimer: t.clearTimer });
  b.add('1');
  b.add('1');
  b.add('2');
  assert.equal(t.count(), 1);
  assert.deepEqual(batches, []);
  t.fire();
  assert.deepEqual(batches, [['1', '2']]);
  ['3', '4', '5', '6', '7'].forEach((id) => b.add(id));
  assert.deepEqual(batches[1], ['3', '4', '5', '6', '7']);
  assert.equal(t.count(), 0);
  b.add('8');
  b.cancel();
  t.fire();
  assert.equal(batches.length, 2);
  b.add('2');
  assert.equal(t.count(), 0);
});

test('qrewing function not deployed (404 / relay / bare 503): one ai_failed, no retry, recap shows "none"', async () => {
  const { invokeFailureKind, matchStep } = await import('../src/features/event/qrewing-plan.ts');
  const { recapMissForError, recapCardView } = await import('../src/features/recap/recap-plan.ts');
  // Supabase gateway body for a missing function has `code`, not `error`.
  assert.equal(invokeFailureKind({ name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code' }), 'http');
  assert.equal(classifyQrewingError(404, undefined), 'ai_failed');
  assert.equal(classifyQrewingError(404, 'NOT_FOUND'), 'ai_failed', 'unknown body code falls back to status');
  assert.equal(invokeFailureKind({ name: 'FunctionsRelayError', message: 'Relay Error' }), 'server');
  // Match: an error is shown once; only a 202 pending schedules a re-ask.
  assert.deepEqual(matchStep({ error: 'ai_failed' }, null, false), { show: 'error', error: 'ai_failed' });
  // Recap: a non-network error is "gone", which shows the plain "no recap" line, not a retry loop.
  assert.equal(recapMissForError('ai_failed'), 'gone');
  assert.equal(recapCardView(false, true, 'gone'), 'none');
  assert.equal(recapCardView(false, false, 'gone'), 'hidden');
});

test('classifyQrewingError: body code wins, else status', () => {
  assert.equal(classifyQrewingError(403, 'ai_off'), 'ai_off');
  assert.equal(classifyQrewingError(409, 'too_early'), 'too_early');
  assert.equal(classifyQrewingError(503), 'ai_failed', 'bare gateway 503');
  assert.equal(classifyQrewingError(503, 'ai_not_configured'), 'ai_not_configured');
  assert.equal(classifyQrewingError(0), 'network');
  assert.equal(classifyQrewingError(401), 'not_member');
  assert.equal(classifyQrewingError(500, 'boom'), 'ai_failed');
  // Contract vs qrewing d30438f: every status/code the function returns, plus a gateway 429 (the function sends none).
  assert.equal(classifyQrewingError(409, 'no_entry'), 'no_entry');
  assert.equal(classifyQrewingError(403, 'not_muted'), 'not_muted');
  assert.equal(classifyQrewingError(403, 'not_member'), 'not_member');
  assert.equal(classifyQrewingError(400, 'bad_request'), 'ai_failed');
  assert.equal(classifyQrewingError(405, 'method_not_allowed'), 'ai_failed');
  assert.equal(classifyQrewingError(500, 'internal'), 'ai_failed');
  assert.equal(classifyQrewingError(429), 'ai_failed', 'gateway rate limit');
  assert.equal(isQrewingError({ error: 'ai_off' }), true);
  assert.equal(isQrewingError({ ok: true }), false);
});

test('newestMs skips pending rows and returns 0 for none', () => {
  assert.equal(newestMs([]), 0);
  const items = [
    { id: 'p', kind: 'text', sender_id: 'me', body: 'x', created_at: '2026-11-12T10:05:00Z', pending: true },
    { id: 'a', kind: 'text', sender_id: 'u', body: 'x', created_at: '2026-11-12T10:01:00Z' },
    { id: 'b', kind: 'text', sender_id: 'u', body: 'x', created_at: '2026-11-12T10:03:00Z' },
  ];
  assert.equal(newestMs(items), Date.parse('2026-11-12T10:03:00Z'));
});

test('pickBanner: a reason shows only on done+important (skipped "model_failed" never reaches the screen)', () => {
  const since = Date.parse('2026-11-12T10:00:00Z');
  const row = (id, min) => ({ id, kind: 'text', sender_id: 'u', body: 'hello', created_at: `2026-11-12T10:0${min}:00Z` });
  const items = [row('skipped', 3), row('notImportant', 2)];
  const flags = new Map([
    ['skipped', { state: 'skipped', important: false, reason: 'model_failed' }],
    ['notImportant', { state: 'done', important: false, reason: 'model_failed' }],
  ]);
  const base = { since, userId: 'me', myName: 'Sam', flags, dismissed: new Set() };
  assert.equal(pickBanner(items, base), null);
  // A skipped row stays visible (nothing hidden without a done verdict).
  assert.equal(staysVisible(items[0], 'me', 'Sam', flags), true);
});

test('pickBanner: newest important or mention after since, not mine, not dismissed', () => {
  const since = Date.parse('2026-11-12T10:00:00Z');
  const row = (id, sender, body, min) => ({ id, kind: 'text', sender_id: sender, body, created_at: `2026-11-12T10:0${min}:00Z` });
  const items = [
    row('mine', 'me', 'Sam look', 6),
    row('plain', 'u', 'nice weather', 5),
    row('flag', 'u', 'Stage moved to hall B', 4),
    row('mention', 'u', 'hey @Sam', 3),
    row('old', 'u', 'Sam before', 0),
  ];
  const flags = new Map([
    ['flag', { state: 'done', important: true, reason: 'Location change' }],
    ['plain', { state: 'done', important: false, reason: null }],
  ]);
  const base = { since, userId: 'me', myName: 'Sam', flags, dismissed: new Set() };
  assert.deepEqual(pickBanner(items, base), {
    messageId: 'flag',
    reason: 'Location change',
    mention: false,
    createdMs: Date.parse('2026-11-12T10:04:00Z'),
  });
  const next = pickBanner(items, { ...base, dismissed: new Set(['flag']) });
  assert.equal(next.messageId, 'mention');
  assert.equal(next.mention, true);
  assert.equal(next.reason, null);
  assert.equal(pickBanner(items, { ...base, dismissed: new Set(['flag', 'mention']) }), null);
});

test('linksByUser keeps up to 3 https links per member and skips empty ones', () => {
  const map = linksByUser([
    { user_id: 'a', links: ['https://x.dev', 'http://bad', 'javascript:alert(1)', 'https://y.dev', 'https://z.dev', 'https://w.dev'] },
    { user_id: 'b', links: [] },
    { user_id: 'c', links: null },
  ]);
  assert.deepEqual(map.get('a'), ['https://x.dev', 'https://y.dev', 'https://z.dev']);
  assert.equal(map.has('b'), false);
  assert.equal(map.has('c'), false);
});

test('isOfflineError: only a request that never got an answer is offline', async () => {
  const { isOfflineError, saveErrorKind } = await import('../src/features/event/qrewing-plan.ts');
  // Offline: the fetch error itself, or a supabase-js error built from it (message "<name>: <message>").
  assert.equal(isOfflineError(new TypeError('Network request failed')), true);
  assert.equal(isOfflineError({ message: 'TypeError: Network request failed', code: '' }), true);
  assert.equal(isOfflineError({ message: 'AbortError: The user aborted a request.', code: '' }), true);
  assert.equal(isOfflineError({ name: 'AbortError', message: 'Aborted' }), true);
  assert.equal(isOfflineError({ name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' }), true);
  // Server failures: gateway 5xx and non-JSON bodies also come back with an empty code.
  assert.equal(isOfflineError({ message: '<html>502 Bad Gateway</html>', code: '' }), false);
  assert.equal(isOfflineError({ message: 'Service Unavailable', code: '' }), false);
  assert.equal(isOfflineError({ message: 'upstream connect error', code: '' }), false);
  assert.equal(isOfflineError({ name: 'FunctionsRelayError', message: 'Relay Error invoking the Edge Function' }), false);
  assert.equal(isOfflineError({ message: 'relation does not exist', code: '42P01' }), false);
  assert.equal(isOfflineError({ message: 'missing table', code: 'PGRST205' }), false);
  assert.equal(isOfflineError(new Error('boom')), false);
  assert.equal(isOfflineError(null), false);
  assert.equal(saveErrorKind({ message: 'TypeError: Network request failed', code: '' }), 'network');
  assert.equal(saveErrorKind({ message: '502 Bad Gateway', code: '' }), 'failed');
  assert.equal(saveErrorKind({ code: 'P0001', message: 'not a member' }), 'failed');
});

test('invokeFailureKind: HTTP errors are read, relay errors are server failures, fetch errors are offline', async () => {
  const { invokeFailureKind } = await import('../src/features/event/qrewing-plan.ts');
  assert.equal(invokeFailureKind({ name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code' }), 'http');
  assert.equal(invokeFailureKind({ name: 'FunctionsRelayError', message: 'Relay Error' }), 'server');
  assert.equal(invokeFailureKind({ name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' }), 'network');
  assert.equal(invokeFailureKind(new TypeError('Network request failed')), 'network');
  assert.equal(invokeFailureKind(new Error('boom')), 'server');
});

test('mentionsName: cached RegExp gives the same answer on repeat calls and follows a name change', async () => {
  const { mentionsName } = await import('../src/features/event/event-plan.ts');
  assert.equal(mentionsName('hi @Bob', 'Bob Lee'), true);
  assert.equal(mentionsName('hi @Bob', 'Bob Lee'), true, 'no lastIndex carry-over');
  assert.equal(mentionsName('hi @Bobby', 'Bob Lee'), false);
  assert.equal(mentionsName('hi @Bob', 'Ann Kim'), false, 'name changed');
  assert.equal(mentionsName('hi @Ann', 'Ann Kim'), true);
  assert.equal(mentionsName('hi @A', 'A'), false, 'short names never match');
});

test('matchStep (68132d6): 202 pending keeps the last list or shows pending, re-asks once, never loops', async () => {
  const { matchStep, MATCH_RETRY_MS } = await import('../src/features/event/qrewing-plan.ts');
  const list = { matches: [{ userId: 'b', displayName: 'B', headline: '', reason: 'r', score: 1 }], cached: false, generatedAt: 't' };
  const stale = { ...list, cached: true, stale: true };
  assert.deepEqual(matchStep(list, null, false), { show: 'list', result: list, pending: false, error: null, retryInMs: null });
  assert.deepEqual(matchStep(stale, list, false), { show: 'list', result: stale, pending: false, error: null, retryInMs: null }, 'stale is no error');
  assert.deepEqual(matchStep({ state: 'pending' }, null, false), { show: 'pending', retryInMs: MATCH_RETRY_MS });
  assert.deepEqual(matchStep({ state: 'pending' }, list, false), { show: 'list', result: list, pending: true, error: null, retryInMs: MATCH_RETRY_MS });
  assert.deepEqual(matchStep({ state: 'pending' }, null, true), { show: 'pending', retryInMs: null }, 're-ask is not repeated');
  assert.deepEqual(matchStep({ state: 'pending' }, list, true), { show: 'list', result: list, pending: true, error: null, retryInMs: null });
  // R4: a failed re-ask keeps the list with an error line; a failed first ask (or no list) is the error view.
  assert.deepEqual(matchStep({ error: 'network' }, list, true), { show: 'list', result: list, pending: false, error: 'network', retryInMs: null });
  assert.deepEqual(matchStep({ error: 'ai_failed' }, list, true), { show: 'list', result: list, pending: false, error: 'ai_failed', retryInMs: null });
  assert.deepEqual(matchStep({ error: 'network' }, null, true), { show: 'error', error: 'network' });
  assert.deepEqual(matchStep({ error: 'no_entry' }, list, false), { show: 'error', error: 'no_entry' });
  assert.equal(MATCH_RETRY_MS, 10_000);
});

test('roomStateFrom (R1): any room read error is readFailed, a missing row or table is off', async () => {
  const { roomStateFrom, ROOM_UNKNOWN } = await import('../src/features/event/qrewing-plan.ts');
  const none = { data: null };
  const failed = { aiEnabled: false, entryRequired: false, me: null, readFailed: true, loaded: true };
  const off = { ...failed, readFailed: false };
  assert.deepEqual(roomStateFrom({ data: null, error: { message: 'TypeError: Network request failed', code: '' } }, none), failed);
  assert.deepEqual(roomStateFrom({ data: null, error: { message: '<html>502 Bad Gateway</html>', code: '' } }, none), failed, 'gateway 5xx');
  assert.deepEqual(roomStateFrom({ data: null, error: { message: 'permission denied', code: '42501' } }, none), failed, 'RLS');
  assert.deepEqual(roomStateFrom({ data: null, error: { message: 'missing', code: 'PGRST205' } }, none), off, '0027 not applied');
  assert.deepEqual(roomStateFrom({ data: null, error: { message: 'missing', code: '42P01' } }, none), off);
  assert.deepEqual(roomStateFrom({ data: null, error: null }, none), off, 'no row');
  const room = { room_id: 'r', ai_enabled: true, entry_required: true };
  assert.deepEqual(roomStateFrom({ data: { ...room, ai_enabled: false }, error: null }, none), off);
  assert.deepEqual(roomStateFrom({ data: room, error: null }, { data: { ai_ok_at: 't', mute_small_talk: true } }), {
    aiEnabled: true, entryRequired: true, me: { aiOk: true, mute: true }, readFailed: false, loaded: true,
  });
  assert.equal(ROOM_UNKNOWN.loaded, false);
  assert.equal(ROOM_UNKNOWN.readFailed, false);
});

test('endCopyHasRecap (R6): recap wording unless a read answered AI off', async () => {
  const { endCopyHasRecap, ROOM_UNKNOWN, ROOM_READ_FAILED } = await import('../src/features/event/qrewing-plan.ts');
  assert.equal(endCopyHasRecap(ROOM_UNKNOWN), true, 'still loading (or no id)');
  assert.equal(endCopyHasRecap(ROOM_READ_FAILED), true, 'read failed');
  assert.equal(endCopyHasRecap({ aiEnabled: false, readFailed: false, loaded: true }), false, 'answered off');
  assert.equal(endCopyHasRecap({ aiEnabled: true, readFailed: false, loaded: true }), true);
});

test('chatGates (B1): sheet closed without an answer + entry required + no profile → entry form, composer locked', () => {
  // me === null: the member swiped the disclosure away without Agree or Not now.
  const g = chatGates(true, null, true, 'event', false);
  assert.deepEqual(g, { disclosure: true, entry: true });
  // The screen hides the sheet after the swipe, but the entry gate does not depend on it.
  const sheetClosed = true;
  const showSheet = g.disclosure && !sheetClosed;
  const composerLocked = g.entry;
  assert.equal(showSheet, false);
  assert.equal(composerLocked, true);
  // Answered (Not now creates the row) and filled in: no gate. Profile unknown (read failed): no lock.
  assert.deepEqual(chatGates(true, { aiOk: false, mute: false }, true, 'event', true), { disclosure: false, entry: false });
  assert.equal(chatGates(true, null, true, 'event', null).entry, false);
  assert.equal(chatGates(false, null, true, 'event', false).entry, true, 'AI off: entry still required');
  assert.equal(chatGates(true, null, true, 'social', false).entry, false);
});

test('nextLoadedOnce (B2): a failed first load starts no mute session; old messages loaded later never alert', () => {
  const row = (id, body, iso) => ({ id, kind: 'text', sender_id: 'u', body, created_at: iso });
  const flags = new Map([['old-flag', { state: 'done', important: true, reason: 'Stage moved' }]]);
  const opts = (since) => ({ since, userId: 'me', myName: 'Sam', flags, dismissed: new Set() });
  // First page fails: list empty, no session (the old code set since = newestMs([]) = 0 here).
  let loaded = nextLoadedOnce(false, false, new Error('offline'));
  assert.equal(loaded, false);
  assert.equal(nextLoadedOnce(false, true, null), false, 'still loading');
  // Retry succeeds and brings in older messages: the session starts now, at the newest of them.
  const old = [row('old-flag', 'x', '2026-11-12T10:02:00Z'), row('old-mention', 'hey @Sam', '2026-11-12T10:01:00Z')];
  loaded = nextLoadedOnce(loaded, false, null);
  assert.equal(loaded, true);
  const since = newestMs(old);
  assert.equal(pickBanner(old, opts(since)), null, 'old important and mention do not alert');
  assert.equal(old.filter((m) => Date.parse(m.created_at) > since).length, 0, 'nothing old is sent to triage');
  // Latched: a later failed reload keeps the session.
  assert.equal(nextLoadedOnce(loaded, false, new Error('offline')), true);
  // A new mention after the start alerts.
  const fresh = [row('new', 'hey @Sam', '2026-11-12T10:03:00Z'), ...old];
  assert.equal(pickBanner(fresh, opts(since))?.messageId, 'new');
});

test('nextLoadedOnce (B2): an empty room that loads fine still alerts on the first new message', () => {
  assert.equal(nextLoadedOnce(false, false, null), true);
  const since = newestMs([]);
  assert.equal(since, 0);
  const first = [{ id: 'm1', kind: 'text', sender_id: 'u', body: 'hey @Sam', created_at: '2026-11-12T10:00:00Z' }];
  assert.equal(pickBanner(first, { since, userId: 'me', myName: 'Sam', flags: new Map(), dismissed: new Set() })?.messageId, 'm1');
});

// First-run path (create with AI -> guest consent -> Introduce yourself), at the plan level.
test('first run: the consent sheet asks until Agree or Not now saves a row; swipe-down saves nothing', async () => {
  const { roomStateFrom } = await import('../src/features/event/qrewing-plan.ts');
  const room = { data: { ai_enabled: true, entry_required: true }, error: null };
  const fresh = roomStateFrom(room, { data: null });
  assert.equal(chatGates(fresh.aiEnabled, fresh.me, true, 'event', false).disclosure, true, 'first open');
  // Swipe-down saves nothing: the next read still has no row, so the sheet asks again.
  assert.equal(chatGates(true, roomStateFrom(room, { data: null }).me, true, 'event', false).disclosure, true);
  const agreed = roomStateFrom(room, { data: { ai_ok_at: '2026-11-12T10:00:00Z', mute_small_talk: false } });
  assert.deepEqual(agreed.me, { aiOk: true, mute: false });
  assert.equal(chatGates(true, agreed.me, true, 'event', true).disclosure, false, 'Agree');
  const later = roomStateFrom(room, { data: { ai_ok_at: null, mute_small_talk: false } });
  assert.deepEqual(later.me, { aiOk: false, mute: false });
  assert.equal(chatGates(true, later.me, true, 'event', true).disclosure, false, 'Not now');
  // Not now keeps my messages out of triage even with Mute on.
  assert.equal(allowedQrewingCalls({ aiEnabled: true, me: { aiOk: false, mute: true } }, true, true).triage, false);
  // The sheet never shows when the probe fails (aiEnabled && available is what reaches chatGates).
  assert.equal(chatGates(false, null, true, 'event', false).disclosure, false);
});

test('first run: the Introduce yourself card shows for an event room without my entry and hides once saved', () => {
  assert.equal(chatGates(true, null, true, 'event', false).entry, true, 'no entry yet');
  assert.equal(chatGates(true, { aiOk: true, mute: false }, true, 'event', true).entry, false, 'entry saved');
  assert.equal(chatGates(true, null, true, 'event', null).entry, false, 'unknown (loading or failed read) does not lock chat');
  assert.equal(chatGates(true, null, false, 'event', false).entry, false, 'host did not ask for entry info');
  assert.equal(chatGates(true, null, true, 'meetup', false).entry, false, 'not an event room');
  assert.equal(chatGates(false, { aiOk: false, mute: false }, true, 'event', false).entry, true, 'Not now or AI down: still asked');
});

test('first run: an AI-off, loading or unreadable room never calls qrewing', async () => {
  const { roomStateFrom, ROOM_UNKNOWN, ROOM_READ_FAILED } = await import('../src/features/event/qrewing-plan.ts');
  const none = { probe: false, triage: false, recap: false };
  const member = { data: { ai_ok_at: 't', mute_small_talk: true } };
  const off = roomStateFrom({ data: { ai_enabled: false, entry_required: true }, error: null }, member);
  assert.equal(off.me, null, 'an AI-off room ignores an old member row');
  for (const state of [off, ROOM_UNKNOWN, ROOM_READ_FAILED, roomStateFrom({ data: null, error: null }, member)]) {
    assert.deepEqual(allowedQrewingCalls(state, true, true), none);
  }
  const on = roomStateFrom({ data: { ai_enabled: true, entry_required: false }, error: null }, member);
  assert.deepEqual(allowedQrewingCalls(on, true, true), { probe: true, triage: true, recap: true });
  assert.equal(allowedQrewingCalls(on, false, true).triage, false, 'probe failed');
  assert.equal(allowedQrewingCalls(on, true, false).triage, false, 'not an event room');
});

test('entryDirty (qa F2): only a change from the loaded form asks before leaving', async () => {
  const { entryDirty } = await import('../src/features/event/event-plan.ts');
  const empty = { headline: '', interests: '', lookingFor: '', links: ['', '', ''] };
  assert.equal(entryDirty(empty, { ...empty }), false, 'untouched new form leaves freely');
  assert.equal(entryDirty(empty, { ...empty, headline: 'CS junior' }), true);
  assert.equal(entryDirty(empty, { ...empty, links: ['', 'https://a.b', ''] }), true);
  const saved = { headline: 'A', interests: 'B', lookingFor: 'C', links: ['https://x.y', '', ''] };
  assert.equal(entryDirty(saved, { ...saved, links: [...saved.links] }), false, 'loaded entry, no edit');
  assert.equal(entryDirty(saved, { ...saved, lookingFor: 'D' }), true);
});

test('roomStateFor: a read for another room never shows; the same room keeps its state across reloads', async () => {
  const { roomStateFor, ROOM_UNKNOWN, ROOM_READ_FAILED } = await import('../src/features/event/qrewing-plan.ts');
  const on = { aiEnabled: true, entryRequired: true, me: { aiOk: true, mute: true }, readFailed: false, loaded: true };
  assert.equal(roomStateFor(null, 'a'), ROOM_UNKNOWN);
  assert.equal(roomStateFor({ roomId: 'a', state: on }, 'a'), on);
  assert.equal(roomStateFor({ roomId: 'a', state: on }, 'b'), ROOM_UNKNOWN);
  assert.equal(roomStateFor({ roomId: 'a', state: ROOM_READ_FAILED }, 'b'), ROOM_UNKNOWN);
});

test('sessionUserId: the id from the stored session (works offline); no session is undefined', async () => {
  const { sessionUserId } = await import('../src/features/event/qrewing-plan.ts');
  assert.equal(sessionUserId({ data: { session: { user: { id: 'u1' } } } }), 'u1');
  assert.equal(sessionUserId({ data: { session: null } }), undefined);
  assert.equal(sessionUserId(null), undefined);
});

test('useQrewingRoom reads the user from getSession, not the network getUser', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/features/event/qrewing-api.ts', import.meta.url), 'utf8');
  assert.match(src, /sessionUserId\(await supabase\.auth\.getSession\(\)\)/);
  assert.doesNotMatch(src, /auth\.getUser\(/);
});
