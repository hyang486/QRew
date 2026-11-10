// Run: npm test. Qrew unit 5: Room info "N people · M arrived" (Q 03.03).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { arrivedMemberCount } from '../src/lib/info-plan.ts';

test('arrivedMemberCount: counts current members who arrived', () => {
  assert.equal(arrivedMemberCount(['a', 'b', 'c'], ['a', 'c']), 2);
});

test('arrivedMemberCount: ignores people who left and duplicate rows', () => {
  assert.equal(arrivedMemberCount(['a', 'b'], ['a', 'x', 'a']), 1);
});

test('arrivedMemberCount: none arrived or no members', () => {
  assert.equal(arrivedMemberCount(['a'], []), 0);
  assert.equal(arrivedMemberCount([], ['a']), 0);
});
