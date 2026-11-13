// Run: npm test. App killed and reopened during grace (qa item, no behavior change): the recap saved on this phone
// reloads from its stored string alone, and the grace screen state (Photos of me / Photos & files, list row) comes
// from the server room row, not from anything held in memory before the restart.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { roomListEntry, roomPhase, screenActions } from '../src/features/recap/grace-plan.ts';
import { parseMark, parseSavedRecap, recapCardView, recapKey } from '../src/features/recap/recap-plan.ts';

const MIN = 60_000;
const ENDED = Date.parse('2026-11-12T12:00:00Z');
const iso = (t) => new Date(t).toISOString();
const room = { deleted_at: iso(ENDED), expires_at: iso(ENDED + 120 * MIN), grace_until: iso(ENDED + 30 * MIN) };
const saved = {
  server: { title: 'Demo night', summary: 'S', highlights: ['a'], generatedAt: iso(ENDED + MIN) },
  me: { messages: 4, mediaShared: 1, photosOfMe: 2, arrivedAt: iso(ENDED - 60 * MIN), pace: null },
  savedAt: iso(ENDED + MIN),
};

test('restart in grace: the stored recap and the grace screen come back from storage and the room row', () => {
  // Before the kill: what AsyncStorage holds under the room's key.
  const storage = new Map([[recapKey('r1'), JSON.stringify(saved)]]);
  // After the reopen, 10 minutes later, with nothing in memory.
  const now = ENDED + 10 * MIN;
  const reloaded = parseSavedRecap(storage.get(recapKey('r1')));
  assert.deepEqual(reloaded, saved);
  // The saved recap shows even without the AI mark and while the network is down.
  assert.equal(recapCardView(reloaded !== null, parseMark(null)?.ai === true, 'offline'), 'recap');
  assert.equal(roomPhase(room, now), 'grace');
  assert.deepEqual(roomListEntry(room, now), { kind: 'grace', untilMs: ENDED + 30 * MIN });
  const pom = screenActions('photos-of-me', roomPhase(room, now));
  assert.equal(pom.view && pom.download && !pom.setup && !pom.endedScreen, true);
  // Reopened after grace: the room is gone from the list, the phone's copy still parses.
  assert.equal(roomPhase(room, ENDED + 31 * MIN), 'ended');
  assert.deepEqual(roomListEntry(room, ENDED + 31 * MIN), { kind: 'hidden' });
  assert.notEqual(parseSavedRecap(storage.get(recapKey('r1'))), null);
});
