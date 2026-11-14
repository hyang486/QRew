// Run: npm test. UI v2 (5): a triage result written after the first 3 s re-read still hides the message.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPendingRechecker, PENDING_RECHECK_DELAYS_MS } from '../src/features/event/pending-recheck.ts';

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  return {
    timers: {
      now: () => now,
      setTimeout: (fn, ms) => {
        const h = ++seq;
        due.set(h, { at: now + ms, fn });
        return h;
      },
      clearTimeout: (h) => due.delete(h),
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        due.delete(next[0]);
        now = next[1].at;
        await next[1].fn();
      }
      now = end;
    },
    pending: () => due.size,
  };
}

// The server row: pending until doneAt, then done.
function server(doneAt) {
  const reads = [];
  return {
    reads,
    read: (clock) => async (ids) => {
      reads.push([clock.now(), [...ids]]);
      return ids.map((id) => ({ id, state: clock.now() >= (doneAt[id] ?? Infinity) ? 'done' : 'pending' }));
    },
  };
}

test('backoff is 3, 6, 12, 24 s', () => {
  assert.deepEqual([...PENDING_RECHECK_DELAYS_MS], [3000, 6000, 12000, 24000]);
});

test("qa's case: the result lands at 3.6 s, so the 9 s re-read applies it and rechecking stops", async () => {
  const f = fakeTimers();
  const s = server({ m1: 3600 });
  const applied = [];
  const r = createPendingRechecker({ read: s.read(f.timers), apply: (rows) => applied.push(...rows), timers: f.timers });
  r.add(['m1']);
  await f.advance(3000);
  assert.deepEqual(applied.at(-1), { id: 'm1', state: 'pending' });
  await f.advance(6000);
  assert.deepEqual(applied.at(-1), { id: 'm1', state: 'done' });
  assert.equal(r.size(), 0);
  await f.advance(60_000);
  assert.deepEqual(s.reads.map(([at]) => at), [3000, 9000]);
});

test('ids due together are read in one call; a never-finished row stops after 4 reads', async () => {
  const f = fakeTimers();
  const s = server({ a: 8_000 });
  const r = createPendingRechecker({ read: s.read(f.timers), apply: () => {}, timers: f.timers });
  r.add(['a', 'b']);
  await f.advance(100_000);
  assert.deepEqual(s.reads, [
    [3000, ['a', 'b']],
    [9000, ['a', 'b']],
    [21000, ['b']],
    [45000, ['b']],
  ]);
  assert.equal(r.size(), 0);
  assert.equal(f.pending(), 0, 'no timer left');
});

test('skipped settles too; a failed read retries on the next step', async () => {
  const f = fakeTimers();
  let fail = true;
  const reads = [];
  const read = async (ids) => {
    reads.push(f.timers.now());
    if (fail) {
      fail = false;
      throw new Error('offline');
    }
    return ids.map((id) => ({ id, state: 'skipped' }));
  };
  const applied = [];
  const r = createPendingRechecker({ read, apply: (rows) => applied.push(...rows), timers: f.timers });
  r.add(['x']);
  await f.advance(100_000);
  assert.deepEqual(reads, [3000, 9000]);
  assert.deepEqual(applied, [{ id: 'x', state: 'skipped' }]);
});

test('clear (mute off) and cancel (screen closed) stop the reads', async () => {
  const f = fakeTimers();
  const s = server({});
  const r = createPendingRechecker({ read: s.read(f.timers), apply: () => {}, timers: f.timers });
  r.add(['a']);
  await f.advance(3000);
  r.clear();
  await f.advance(60_000);
  assert.equal(s.reads.length, 1);
  r.add(['b']);
  await f.advance(3000);
  assert.equal(s.reads.length, 2, 'add works after clear');
  r.cancel();
  r.add(['c']);
  await f.advance(60_000);
  assert.equal(s.reads.length, 2);
});

test('a later add joins the next due read without restarting earlier ids', async () => {
  const f = fakeTimers();
  const s = server({});
  const r = createPendingRechecker({ read: s.read(f.timers), apply: () => {}, timers: f.timers });
  r.add(['a']);
  await f.advance(1000);
  r.add(['b', 'a']);
  await f.advance(2000);
  assert.deepEqual(s.reads.at(-1), [3000, ['a']]);
  await f.advance(1000);
  assert.deepEqual(s.reads.at(-1), [4000, ['b']]);
});
