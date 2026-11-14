// Run: npm test. Qrewing Calendar labels and date-picker conversion (DST-safe).
import './ts-resolve.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const f = await import('../src/features/calendar/calendar-format.ts');

test('labels never shift the key day', () => {
  assert.equal(f.dayTitle('2026-11-15', 'en-US'), 'Sunday, November 15');
  assert.equal(f.monthTitle(2026, 10, 'en-US'), 'November 2026');
  assert.equal(f.rangeLabel('2026-11-15', '2026-11-15', 2026, 'en-US'), 'Nov 15');
  assert.match(f.rangeLabel('2026-11-15', '2026-11-17', 2026, 'en-US'), /^Nov 15\s?–\s?17$/);
  assert.match(f.rangeLabel('2026-12-30', '2027-01-02', 2026, 'en-US'), /2026.*2027/);
  assert.deepEqual(f.weekdayLabels(0, 'en-US'), ['S', 'M', 'T', 'W', 'T', 'F', 'S']);
  assert.equal(f.weekdayLabels(1, 'en-US')[0], 'M');
});

test('date picker round trip holds on DST change days', () => {
  for (const k of ['2026-03-08', '2026-11-01', '2026-12-31', '2028-02-29']) assert.equal(f.localDateToKey(f.keyToLocalDate(k)), k);
});

test('rangeLabel without Intl formatRange (Hermes): no crash, same labels', () => {
  const saved = Intl.DateTimeFormat.prototype.formatRange;
  delete Intl.DateTimeFormat.prototype.formatRange;
  try {
    assert.equal(f.rangeLabel('2026-11-15', '2026-11-17', 2026, 'en-US'), 'Nov 15 – 17');
    assert.equal(f.rangeLabel('2026-11-30', '2026-12-02', 2026, 'en-US'), 'Nov 30 – Dec 2');
    assert.equal(f.rangeLabel('2026-12-30', '2027-01-02', 2026, 'en-US'), 'Dec 30, 2026 – Jan 2, 2027');
  } finally {
    Intl.DateTimeFormat.prototype.formatRange = saved;
  }
});
