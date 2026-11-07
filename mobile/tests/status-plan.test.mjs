// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeStatusLabels,
  removedStatusLabels,
  STATUS_LABEL_MAX,
  statusLabelLength,
  statusLabelsChanged,
} from '../src/lib/status-plan.ts';

test('normalizeStatusLabels trims, keeps order and drops blank rows', () => {
  assert.deepEqual(normalizeStatusLabels(['  Resting ', '', '   ', 'Need water']), {
    ok: true,
    labels: ['Resting', 'Need water'],
  });
  assert.deepEqual(normalizeStatusLabels([]), { ok: true, labels: [] });
});

test('normalizeStatusLabels allows exactly STATUS_LABEL_MAX characters and rejects one more', () => {
  const max = 'a'.repeat(STATUS_LABEL_MAX);
  assert.deepEqual(normalizeStatusLabels([max]), { ok: true, labels: [max] });
  assert.deepEqual(normalizeStatusLabels([max + 'b']), { ok: false, error: 'tooLong', label: max + 'b' });
});

test('normalizeStatusLabels counts code points like char_length (emoji count once)', () => {
  const emoji = '🏃'.repeat(STATUS_LABEL_MAX);
  assert.equal(statusLabelLength(emoji), STATUS_LABEL_MAX);
  assert.deepEqual(normalizeStatusLabels([emoji]), { ok: true, labels: [emoji] });
  assert.equal(normalizeStatusLabels([emoji + '🏃']).ok, false);
});

test('normalizeStatusLabels rejects Emergency in any case (it is fixed)', () => {
  assert.deepEqual(normalizeStatusLabels(['Resting', ' eMeRgEnCy ']), {
    ok: false,
    error: 'emergency',
    label: 'eMeRgEnCy',
  });
});

test('normalizeStatusLabels rejects a repeated label, case-insensitive', () => {
  assert.deepEqual(normalizeStatusLabels(['Resting', 'resting ']), {
    ok: false,
    error: 'duplicate',
    label: 'resting',
  });
});

test('removedStatusLabels lists saved labels that a rename or removal drops', () => {
  assert.deepEqual(removedStatusLabels(['Resting', 'Need water'], ['Resting', 'Need food']), ['Need water']);
  assert.deepEqual(removedStatusLabels(['Resting'], ['Need water', 'Resting']), []);
});

test('statusLabelsChanged detects edits and reordering only', () => {
  assert.equal(statusLabelsChanged(['A', 'B'], ['A', 'B']), false);
  assert.equal(statusLabelsChanged(['A', 'B'], ['B', 'A']), true);
  assert.equal(statusLabelsChanged(['A'], ['A', 'B']), true);
});
