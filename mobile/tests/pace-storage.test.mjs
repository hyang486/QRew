// Run: npm test. Pace history saves (storage.ts) with AsyncStorage stubbed in-process: a failed history read must
// not overwrite the stored history with the one session being saved.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const stub = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@react-native-async-storage/async-storage') {
      return {
        url: stub(`const m = globalThis.__store = new Map();
export default {
  getItem: async (k) => { if (globalThis.__failRead) throw new Error('read failed'); return m.get(k) ?? null; },
  setItem: async (k, v) => { m.set(k, v); },
  removeItem: async (k) => { m.delete(k); },
};`),
        shortCircuit: true,
      };
    }
    return next(specifier.startsWith('./') && !specifier.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
  },
});

const { loadHistory, saveSession } = await import('../src/features/pace/storage.ts');

const session = (startedAt) => ({ roomId: 'r', startedAt, durationS: 600, elapsedS: 600, distanceM: 2000, avgSecPerKm: 300, splits: [300, 300] });

test('a failed history read rejects the save and keeps the stored history', async () => {
  globalThis.__failRead = false;
  await saveSession(session(1));
  await saveSession(session(2));
  assert.equal((await loadHistory()).length, 2);

  globalThis.__failRead = true;
  await assert.rejects(saveSession(session(3)), /read failed/);
  globalThis.__failRead = false;
  assert.deepEqual((await loadHistory()).map((s) => s.startedAt), [2, 1]);

  // The queue keeps working after a failed save.
  await saveSession(session(3));
  assert.deepEqual((await loadHistory()).map((s) => s.startedAt), [3, 2, 1]);
});
