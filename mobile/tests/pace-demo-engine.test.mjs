// Run: npm test. Replays the qa demo's GPS legs (scripts/pace-gps-demo.mjs; docs/evidence/qrewing-demo-scenario.md
// act 1) through the real engine.ts, voice.ts and summary.ts, with React Native, AsyncStorage and expo-speech stubbed
// in-process. Each expo-speech variant (absent, present) loads its own copy of the pace modules (a `?v=` query).
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mock, test } from 'node:test';

import { plans, ROUTE, slice } from '../../scripts/pace-gps-demo.mjs';
import { en } from '../src/i18n/en.ts';

const SRC = new URL('../src/', import.meta.url).href;
const stub = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
const STUBS = {
  react: stub('export const useSyncExternalStore = () => null;'),
  'react-native': stub('export const Vibration = { vibrate: () => globalThis.__pace.log.push(["vibrate", Date.now()]) };'),
  expo: stub('export const requireOptionalNativeModule = () => (globalThis.__pace.speech ? {} : null);'),
  '@react-native-async-storage/async-storage': stub(`const m = new Map();
export default { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => { m.set(k, v); }, removeItem: async (k) => { m.delete(k); } };`),
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    const variant = context.parentURL?.match(/\?v=\w+$/)?.[0];
    const spec = specifier.startsWith('@/') ? `${SRC}${specifier.slice(2)}.ts` : specifier;
    const r = next(spec.startsWith('./') && variant && !spec.endsWith('.ts') ? `${spec}.ts` : spec, context);
    return variant && r.url.startsWith(`${SRC}features/pace/`) ? { ...r, url: `${r.url}${variant}` } : r;
  },
});

/** expo-speech: each utterance takes 3 s; stop() ends the current one with onStopped, as the native module does. */
function fakeSpeech(log) {
  let current = null;
  return {
    speak(text, opts) {
      log.push(['speak', Date.now(), text]);
      current = { opts, timer: setTimeout(() => ((current = null), opts.onDone()), 3000) };
    },
    async stop() {
      log.push(['stop', Date.now()]);
      if (!current) return;
      const { opts, timer } = current;
      current = null;
      clearTimeout(timer);
      opts.onStopped();
    },
  };
}

/** Loads engine/voice/summary with expo-speech absent or present (its own module copies) and fake timers at 0. */
let loads = 0;
async function load(t, variant) {
  const log = [];
  globalThis.__pace = { log, speech: variant === 'present' };
  globalThis.require = (id) => {
    if (id === 'expo-speech' && variant === 'present') return fakeSpeech(log);
    throw new Error(`unexpected require ${id}`);
  };
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const q = `?v=${variant}${++loads}`;
  const engine = await import(`../src/features/pace/engine.ts${q}`);
  const voice = await import(`../src/features/pace/voice.ts${q}`);
  const summary = await import(`../src/features/pace/summary.ts${q}`);
  const banner = [];
  voice.onCue((text) => banner.push([Date.now(), text]));
  return { engine, voice, summary, log, banner, tick: (ms) => t.mock.timers.tick(ms) };
}

const REPORT_S = 5; // the reporter's interval while moving
const HEARTBEAT_S = 30; // and while standing still
const TARGET = 300;
const route = ROUTE.map(([latitude, longitude]) => ({ latitude, longitude }));
const pointAt = (m) => {
  const [latitude, longitude] = slice(m, m + 0.01)[0];
  return { latitude, longitude };
};
function stateAt(legs, t) {
  let start = 0;
  for (const leg of legs) {
    const end = start + leg.seconds;
    if (t <= end) {
      const into = t - start;
      if (leg.kind === 'hold') return { m: leg.atM, mps: 0, report: Math.round(into) % HEARTBEAT_S === 0 };
      return { m: leg.fromM + leg.mps * into, mps: leg.mps, report: Math.round(t) % REPORT_S === 0 };
    }
    start = end;
  }
  return null;
}

/** Drives one device (`me`) through the engine second by second, as the Map screen does; returns the prompt times. */
function drive({ engine, tick }, plan, me, roomId) {
  const key = engine.runKey(roomId, 1);
  const prompts = [];
  for (let t = 0; ; t += 1) {
    if (t) tick(1000);
    const mine = stateAt(plan[me], t);
    if (!mine) break;
    const nowMs = t * 1000;
    if (mine.report) {
      const others = Object.keys(plan).flatMap((who) => {
        const s = who === me ? mine : stateAt(plan[who], t);
        return s ? [{ userId: who, point: pointAt(s.m), speedMps: s.mps }] : [];
      });
      const fix = { ...pointAt(mine.m), atMs: nowMs, accuracyM: 5 };
      engine.feedFixes(key, [fix], { roomId, userId: me, nowMs, targetSecPerKm: TARGET, route, place: null, others });
    }
    if (t % 5 === 0 && engine.checkStationary(key, nowMs, 0)) prompts.push(t);
  }
  engine.flushRun(key);
  return { key, prompts };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const secs = (log, kind) => log.filter((e) => e[0] === kind).map((e) => e[1] / 1000);

test('steady (act 1 run), speech absent: 3 km cues vibrate and show; nothing is spoken; recap line', async (t) => {
  const s = await load(t, 'absent');
  assert.equal(s.voice.canSpeak, false);
  drive(s, plans('steady'), 'host', 'steady-absent');
  const p = en.pace;
  assert.deepEqual(
    s.banner.map((b) => b[1]),
    [p.cueKm(1, '5:00', '5:00'), p.cueKm(2, '5:00', '5:00'), p.cueKm(3, '5:00', '5:00')],
  );
  s.banner.forEach(([ms], i) => assert.ok(near(ms / 1000, 300 * (i + 1), 15), `km ${i + 1} at ${ms}`));
  assert.deepEqual(secs(s.log, 'vibrate'), s.banner.map((b) => b[0] / 1000));
  assert.equal(s.log.filter((e) => e[0] === 'speak').length, 0);
  s.voice.stopSpeech(); // no expo-speech: a no-op, never throws
  const line = s.summary.paceRecapLine(await s.summary.getActivitySummary('steady-absent'));
  assert.match(line, /^Pace maker: 3\.\d\d km, moving (\d+):\d\d, total \1:\d\d, 5:0\d per km$/);
});

test('gap (guest), speech present: every cue spoken in speech wording, at least 20 s apart', async (t) => {
  const s = await load(t, 'present');
  assert.equal(s.voice.canSpeak, true);
  drive(s, plans('gap'), 'guest', 'gap-present');
  const spoken = s.log.filter((e) => e[0] === 'speak');
  assert.equal(spoken.length, s.banner.length);
  spoken.forEach(([, ms], i) => assert.equal(ms, s.banner[i][0]));
  // Speech never says "m:ss" or "km"; the banner does.
  for (const [, , text] of spoken) assert.doesNotMatch(text, /\d:\d\d|\bkm\b/, text);
  assert.ok(s.banner[0][1].startsWith('Pick it up'), s.banner[0][1]);
  const gaps = s.banner.filter((b) => b[1].startsWith('Lead group'));
  assert.ok(gaps.length >= 2 && near(gaps[0][0] / 1000, 180, 20), JSON.stringify(s.banner));
  for (let i = 1; i < spoken.length; i++) assert.ok(spoken[i][1] - spoken[i - 1][1] >= 20_000);
  const line = s.summary.paceRecapLine(await s.summary.getActivitySummary('gap-present'));
  assert.match(line, /^Pace maker: 3\.\d\d km, moving /);
});

test('act 1.7: host stops 4 min while the guest runs on; sheet at ~6:00 spoken once; host recap shows the stop', async (t) => {
  const s = await load(t, 'present');
  const plan = { host: plans('stop').host, guest: plans('steady').host };
  const host = drive(s, plan, 'host', 'stop-present');
  assert.equal(host.prompts.length, 1);
  assert.ok(near(host.prompts[0], 360, 15), `prompt at ${host.prompts[0]}s`);
  const texts = s.banner.map((b) => b[1]);
  assert.equal(texts.filter((x) => x === en.pace.stationaryTitle).length, 1);
  assert.deepEqual(
    s.log.filter((e) => e[0] === 'speak' && e[2] === en.pace.stationaryTitle).map((e) => e[1] / 1000),
    host.prompts,
  );
  // The guest is ahead after the stop: the host hears gap cues, none while standing still or within 20 s of the sheet.
  for (const [ms, text] of s.banner) {
    const at = ms / 1000;
    if (text.startsWith('Lead group')) assert.ok(at > 420 || at < 180, `gap cue at ${at}s during the stop`);
  }
  assert.ok(texts.some((x) => x.startsWith(en.pace.cueKm(1, '5:00', '5:00').slice(0, 6))), JSON.stringify(texts));
  const sum = await s.summary.getActivitySummary('stop-present');
  assert.ok(near(sum.distanceM, 1300, 20) && near(sum.durationS, 390, 15) && near(sum.elapsedS, 630, 15), JSON.stringify(sum));
  assert.match(s.summary.paceRecapLine(sum), /^Pace maker: 1\.30 km, moving 6:[23]\d, total 10:[23]\d, 5:0\d per km$/);

  // The guest's own leg (no stop): no sheet, km cues only.
  const g = await load(t, 'present');
  const guest = drive(g, plan, 'guest', 'stop-guest');
  assert.equal(guest.prompts.length, 0);
  assert.deepEqual(g.banner.map((b) => b[1].split(':')[0]), ['Kilometer 1', 'Kilometer 2', 'Kilometer 3']);
});

test('speech queue: a cue during speech waits (newest only); stopSpeech stops and drops the waiting one', async (t) => {
  const s = await load(t, 'present');
  s.voice.speak('one');
  s.voice.speak('two');
  s.voice.speak('three'); // replaces "two" as the waiting cue
  assert.deepEqual(s.log.filter((e) => e[0] === 'speak').map((e) => e[2]), ['one']);
  assert.deepEqual(s.banner.map((b) => b[1]), ['one', 'two', 'three']);
  s.tick(3000); // "one" is done
  assert.deepEqual(s.log.filter((e) => e[0] === 'speak').map((e) => e[2]), ['one', 'three']);
  s.voice.speak('four');
  s.voice.stopSpeech(); // "three" stops (onStopped); "four" is dropped
  await Promise.resolve();
  s.tick(30_000);
  assert.deepEqual(s.log.filter((e) => e[0] === 'speak').map((e) => e[2]), ['one', 'three']);
  assert.equal(s.log.filter((e) => e[0] === 'stop').length, 1);
  // After a stop the next cue is said right away.
  s.voice.speak('five');
  assert.equal(s.log.at(-1)[2], 'five');
});

/**
 * qa's stop-leg bug (main eeeafd9): the host stood still with the sheet up and got "Lead group 774 meters ahead. Run
 * 2:11 per km". A fix wobbling ±20 m (over the 30 m noise floor, inside the 25 m stationary radius) reads as movement,
 * so recent pace is not null. Host: runs 600 m, stands 240 s jumping (heartbeat every 30 s), runs on; the lead runs
 * steadily 200 m ahead of the host's start.
 */
function driveWobble(s, { closeSheetAtS = null } = {}) {
  const { engine, tick } = s;
  const key = engine.runKey('wobble', 1);
  const prompts = [];
  for (let t = 0; t <= 660; t += 1) {
    if (t) tick(1000);
    const nowMs = t * 1000;
    const holding = t > 180 && t < 420;
    const report = holding ? (t - 180) % HEARTBEAT_S === 0 : t % REPORT_S === 0;
    if (report) {
      const m = t <= 180 ? (600 * t) / 180 : holding ? 600 + (((t - 180) / HEARTBEAT_S) % 2 ? 34 : 0) : 600 + (t - 420) * (10 / 3);
      const others = [
        { userId: 'host', point: pointAt(m), speedMps: holding ? 0 : 10 / 3 },
        { userId: 'lead', point: pointAt(200 + (t * 10) / 3), speedMps: 10 / 3 },
      ];
      engine.feedFixes(key, [{ ...pointAt(m), atMs: nowMs, accuracyM: 5 }], {
        roomId: 'wobble', userId: 'host', nowMs, targetSecPerKm: TARGET, route, place: null, others,
      });
    }
    if (t % 5 === 0 && engine.checkStationary(key, nowMs, 0)) prompts.push(t);
    if (closeSheetAtS != null && t === closeSheetAtS) engine.closeStationaryPrompt(key, nowMs);
  }
  return prompts;
}

test('no gap cue while standing still with a wobbling fix or with the sheet open; too far says keep your pace', async (t) => {
  const s = await load(t, 'absent');
  const prompts = driveWobble(s);
  assert.equal(prompts.length, 1, `one sheet: ${prompts}`);
  const p = en.pace;
  const gaps = s.banner.filter((b) => b[1].startsWith('Lead group'));
  // While running behind (200 m): a catch-up pace. Nothing from the stop (180-420 s); the sheet stays open after it.
  assert.ok(gaps.length >= 1 && gaps.every(([ms]) => ms <= 180_000), JSON.stringify(gaps));
  assert.match(gaps[0][1], /Run 3:\d\d per km/);
  const cues = (banner) => banner.filter(([, text]) => text !== p.stationaryTitle);
  assert.ok(cues(s.banner).every(([ms]) => ms <= 180_000 || ms >= 420_000), JSON.stringify(s.banner));

  // Sheet closed at 425 s (moving again): ~1000 m behind needs ~1:52 per km, under 70% of 5:00, so keep your pace.
  const s2 = await load(t, 'absent');
  driveWobble(s2, { closeSheetAtS: 425 });
  const after = s2.banner.filter(([ms, text]) => ms > 420_000 && text.startsWith('Lead group'));
  assert.ok(after.length >= 1, JSON.stringify(s2.banner));
  assert.match(after[0][1], /^Lead group \d+ meters ahead\. Too far to catch in 3 minutes: keep your pace\.$/);
  assert.ok(cues(s2.banner).every(([ms]) => ms <= 180_000 || ms >= 425_000), JSON.stringify(s2.banner));
});
