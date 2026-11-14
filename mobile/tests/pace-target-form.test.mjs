// Run: npm test. Pace target form (E2E finding j): prefill and the empty-field Save rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const f = await import('../src/features/pace/target-form.ts');

test('initialPaceSec: saved target pace wins, then usual pace, else null', () => {
  assert.equal(f.initialPaceSec({ kind: 'pace', secPerKm: 330 }, 300), 330);
  assert.equal(f.initialPaceSec({ kind: 'usual' }, 300), 300);
  assert.equal(f.initialPaceSec({ kind: 'time', distanceM: 10000, timeS: 3000 }, 345), 345);
  assert.equal(f.initialPaceSec({ kind: 'usual' }, null), null);
});

test('targetFieldsFilled: empty or blank fields keep Save disabled', () => {
  assert.equal(f.targetFieldsFilled('pace', '', '', ''), false);
  assert.equal(f.targetFieldsFilled('pace', '  ', '', ''), false);
  assert.equal(f.targetFieldsFilled('pace', '5:30', '', ''), true);
  assert.equal(f.targetFieldsFilled('time', '', '10', ''), false);
  assert.equal(f.targetFieldsFilled('time', '', '', '50:00'), false);
  assert.equal(f.targetFieldsFilled('time', '', '10', '50:00'), true);
  assert.equal(f.targetFieldsFilled('usual', '', '', ''), true);
});
