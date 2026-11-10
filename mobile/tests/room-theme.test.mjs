// Run: npm test (node --test, Node 24 strips the .ts types).
// Qrew R1: every case from planning/QREW_REDESIGN_WORKLIST_EN.md plus the supervisor's rulings.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handFontFor, HAND_FONT_KOREAN, HAND_FONT_LATIN } from '../src/lib/hand-font.ts';
import { artEntry, DRAWN_BY_DEV, INK_DRAWINGS, themeArt } from '../src/lib/ink-art.ts';
import { roomTheme } from '../src/lib/room-theme.ts';

const cases = {
  run: ['Saturday Run Crew', '토요 러닝', '달리기', 'marathon', '  saturday RUN crew ', '러닝크루', '런닝 모임', '한강 마라톤',
    'Morning Jog', 'jogging club', 'Runners', 'ＲＵＮ club', 'run크루'],
  hike: ['Sunset Hike', 'Sunday Hike', '북한산 등산', 'Hiking day', 'trek', 'Trekking Nepal', '하이킹', '주말 산행'],
  bike: ['Sunday Bike Ride', '한강 자전거', 'cycling', 'Bike Ride', 'Motor Bike', 'Bicycle club', 'Cyclists', '사이클 동호회', 'biking'],
  motorcycle: ['Motorcycle Meetup', '오토바이 모임', 'Motorbikes', '모터사이클 투어', 'motorcycles and bikes'],
  gathering: ['Team Meetup', '팀 미팅', 'Weekend Crew', 'Ride', '', '   ', '🏃‍♀️🏃', '🚴', 'brunch', 'Crunch Time', 'trunk',
    '바이크', '라이딩', 'riding', 'Sunday ride', 'Bikers', 'runway show', 'prune'],
};

for (const [theme, names] of Object.entries(cases)) {
  test(`roomTheme → ${theme}`, () => {
    for (const name of names) assert.equal(roomTheme(name), theme, JSON.stringify(name));
  });
}

test('roomTheme: null and undefined are a gathering', () => {
  assert.equal(roomTheme(null), 'gathering');
  assert.equal(roomTheme(undefined), 'gathering');
});

test('roomTheme: the same name with other spacing and case gives the same theme', () => {
  assert.equal(roomTheme('  saturday RUN crew '), roomTheme('Saturday Run Crew'));
});

test('handFontFor: Hangul anywhere picks the Korean hand font; otherwise the Latin one', () => {
  assert.equal(handFontFor('Saturday Run Crew'), HAND_FONT_LATIN);
  assert.equal(handFontFor('토요 러닝'), HAND_FONT_KOREAN);
  assert.equal(handFontFor('Run 크루'), HAND_FONT_KOREAN);
  assert.equal(handFontFor('🏃'), HAND_FONT_LATIN);
});

test('themeArt: each of the five themes has its own art; an unknown theme falls back to gathering', () => {
  const keys = ['run', 'hike', 'bike', 'motorcycle', 'gathering'].map((t) => themeArt(t).key);
  assert.deepEqual(keys, ['run', 'hike', 'bike', 'motorcycle', 'gathering']);
  assert.equal(new Set(keys).size, 5);
  assert.equal(themeArt('swimming').key, 'gathering');
  assert.equal(themeArt(roomTheme('Saturday Run Crew')).kind, 'image');
  assert.equal(themeArt(roomTheme('Sunday Bike Ride')).kind, 'drawing');
});

test('ink drawings: dev-drawn, every path well-formed, aspect from the viewBox', () => {
  assert.equal(DRAWN_BY_DEV, true);
  for (const [key, d] of Object.entries(INK_DRAWINGS)) {
    assert.equal(d.viewBox, `0 0 ${d.width} ${d.height}`, key);
    for (const path of d.paths) assert.match(path, /^M[\d. ]+[MLQCAZ\d. ]*$/, `${key}: ${path}`);
    assert.equal(artEntry(key).aspect, d.width / d.height);
  }
});

test('ink drawings (supervisor A1): hike, bike and motorcycle fill a runner-like frame with a person in it', () => {
  // run.png is 305 x 281 (aspect 1.09) cropped to the drawing; the redrawn art fills its viewBox the same way.
  for (const key of ['hike', 'bike', 'motorcycle']) {
    const d = INK_DRAWINGS[key];
    const aspect = d.width / d.height;
    assert.ok(aspect >= 1.05 && aspect <= 1.25, `${key} aspect ${aspect}`);
    // body parts are closed (paper-filled) shapes, so the figure has volume and hides the frame behind it
    assert.ok(d.paths.filter((p) => p.endsWith('Z')).length >= 8, key);
  }
});

test('roomTheme (supervisor F1): Korean compounds that only contain a term are a gathering', () => {
  for (const name of ['머신러닝 스터디', '딥러닝', '이러닝 강의', 'e러닝', 'E러닝 모임', '부산행', '부산행 KTX', '리사이클 캠페인']) {
    assert.equal(roomTheme(name), 'gathering', name);
  }
});

test('roomTheme (supervisor F1): the real terms still match next to an excluded compound', () => {
  assert.equal(roomTheme('러닝크루'), 'run');
  assert.equal(roomTheme('북한산 등산'), 'hike');
  assert.equal(roomTheme('한강 자전거'), 'bike');
  assert.equal(roomTheme('딥러닝 끝나고 러닝'), 'run');
  assert.equal(roomTheme('부산행 산행'), 'hike');
  assert.equal(roomTheme('리사이클 사이클'), 'bike');
});
