// Run: npm test. Private Qrewing chat (spec 10.3, 10.4): history trim, parse and purge, the ask request shape and
// bounds, and the error mapping (plan, API with a fake invoke, and the AsyncStorage store stubbed in-process).
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const stub = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@react-native-async-storage/async-storage') {
      return {
        url: stub(`const m = globalThis.__askStore = new Map();
export default {
  getItem: async (k) => m.get(k) ?? null,
  setItem: async (k, v) => { m.set(k, v); },
  removeItem: async (k) => { m.delete(k); },
  getAllKeys: async () => [...m.keys()],
  multiRemove: async (ks) => { ks.forEach((k) => m.delete(k)); },
};`),
        shortCircuit: true,
      };
    }
    return next(specifier.startsWith('./') && !specifier.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
  },
});

const plan = await import('../src/features/event/ask-plan.ts');
const store = await import('../src/features/event/ask-store.ts');
const { classifyQrewingError } = await import('../src/features/event/qrewing-plan.ts');

const turn = (i) => ({ q: `q${i}`, a: `a${i}`, at: 1000 + i });
const turns = (n) => Array.from({ length: n }, (_, i) => turn(i));

test('history keeps the newest 30 turns, oldest first', () => {
  const kept = plan.trimHistory(turns(35));
  assert.equal(kept.length, 30);
  assert.equal(kept[0].q, 'q5');
  assert.equal(kept[29].q, 'q34');
  assert.deepEqual(plan.trimHistory(turns(3)), turns(3));
});

test('a stored history parses, drops bad turns and survives garbage', () => {
  assert.deepEqual(plan.parseHistory(null), []);
  assert.deepEqual(plan.parseHistory('not json'), []);
  assert.deepEqual(plan.parseHistory('{"q":1}'), []);
  assert.deepEqual(plan.parseHistory(JSON.stringify([turn(1), { q: 'x' }, null, turn(2)])), [turn(1), turn(2)]);
  assert.equal(plan.parseHistory(JSON.stringify(turns(40))).length, 30);
});

test('the key is qrewing.ask.v1.<roomId> and stale keys are only other rooms’ histories', () => {
  assert.equal(plan.askKey('r1'), 'qrewing.ask.v1.r1');
  assert.equal(plan.askKeyRoom('qrewing.ask.v1.r1'), 'r1');
  assert.equal(plan.askKeyRoom('qrewing.ask.v1.'), null);
  assert.equal(plan.askKeyRoom('recap.r1'), null);
  const keys = ['qrewing.ask.v1.live', 'qrewing.ask.v1.gone', 'recap.gone', 'qrewing.ask.v2.gone'];
  assert.deepEqual(plan.staleAskKeys(keys, ['live']), ['qrewing.ask.v1.gone']);
});

test('a question is trimmed, 1 to 300 characters (emoji count once)', () => {
  assert.equal(plan.askQuestion('  hi  '), 'hi');
  assert.equal(plan.askQuestion('   '), null);
  assert.equal(plan.askQuestion('a'.repeat(300)), 'a'.repeat(300));
  assert.equal(plan.askQuestion('a'.repeat(301)), null);
  assert.equal(plan.askQuestion('🏃'.repeat(300)), '🏃'.repeat(300));
});

test('the request sends the last 4 turns, each side cut to 300, and only a whole me', () => {
  const long = turns(6);
  long[5] = { q: 'x'.repeat(400), a: 'y'.repeat(301), at: 9 };
  const me = { elapsedSec: 600, distanceM: 2000, paceSecPerKm: 300, activity: 'moving' };
  const body = plan.askBody('r1', 'where next?', long, me, 'America/Los_Angeles');
  assert.deepEqual(Object.keys(body), ['action', 'roomId', 'question', 'history', 'me', 'tz']);
  assert.equal(body.action, 'ask');
  assert.deepEqual(body.history.map((h) => h.q.slice(0, 2)), ['q2', 'q3', 'q4', 'xx']);
  assert.equal(body.history[3].q.length, 300);
  assert.equal(body.history[3].a.length, 300);
  assert.deepEqual(Object.keys(body.history[0]), ['q', 'a']);
  assert.deepEqual(body.me, me);
  // Optional fields are left out, not sent as null.
  assert.deepEqual(plan.askBody('r1', 'q', [], null), { action: 'ask', roomId: 'r1', question: 'q' });
  // A null pace (under 100 m, or slower than 3600 s/km) is left out; the rest of me is still sent.
  assert.deepEqual(plan.askBody('r1', 'q', [], { ...me, paceSecPerKm: null }).me, { elapsedSec: 600, distanceM: 2000, activity: 'moving' });
  assert.deepEqual(plan.askBody('r1', 'q', [], { ...me, paceSecPerKm: Number.NaN }).me, { elapsedSec: 600, distanceM: 2000, activity: 'moving' });
  assert.equal(plan.askBody('r1', 'q', [], { ...me, elapsedSec: Number.NaN }).me, undefined);
  assert.equal(plan.askBody('r1', 'q', [], { ...me, activity: 'running' }).me, undefined);
  assert.equal(plan.askBody('r1', 'q', [], { ...me, distanceM: -1 }).me, undefined);
});

test('contract errors map to the four the ask screen names', () => {
  assert.equal(classifyQrewingError(403, 'not_consented'), 'not_consented');
  assert.equal(classifyQrewingError(429, 'ask_limit'), 'ask_limit');
  assert.equal(classifyQrewingError(502, 'ai_failed'), 'ai_failed');
  assert.equal(classifyQrewingError(0), 'network');
  // A known body code wins over the status: a 403 with not_consented or ask_limit is not not_member.
  assert.equal(classifyQrewingError(403, 'ask_limit'), 'ask_limit');
  assert.equal(classifyQrewingError(401, 'not_consented'), 'not_consented');
  assert.equal(classifyQrewingError(403), 'not_member');
  assert.equal(classifyQrewingError(403, 'something_else'), 'not_member');
  for (const e of ['not_consented', 'ask_limit', 'ai_failed', 'network', 'not_member']) assert.equal(plan.askErrorKind(e), e);
  for (const e of ['ai_off', 'ai_not_configured', 'too_early']) assert.equal(plan.askErrorKind(e), 'ai_failed');
});

test('a 200 answer needs a non-empty answer string', () => {
  assert.deepEqual(plan.parseAskAnswer({ answer: ' Hi ', usage: { input: 5, output: 2 } }), { answer: 'Hi', usage: { input: 5, output: 2 } });
  assert.equal(plan.parseAskAnswer({ answer: '  ' }), null);
  assert.equal(plan.parseAskAnswer(null), null);
  assert.equal(plan.parseAskAnswer({ usage: {} }), null);
});

test('the store appends up to 30 turns and purges one room or every stale room', async () => {
  for (const t of turns(32)) await store.appendAskTurn('a', t);
  await store.appendAskTurn('b', turn(1));
  await store.appendAskTurn('c', turn(1));
  globalThis.__askStore.set('other.key', 'x');
  const a = await store.loadAskHistory('a');
  assert.equal(a.length, 30);
  assert.equal(a[29].q, 'q31');
  await store.purgeAskHistory('a');
  assert.deepEqual(await store.loadAskHistory('a'), []);
  await store.purgeStaleAskHistories(['b']);
  assert.deepEqual([...globalThis.__askStore.keys()].sort(), ['other.key', 'qrewing.ask.v1.b']);
});
