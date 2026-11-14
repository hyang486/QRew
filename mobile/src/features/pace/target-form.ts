import type { PaceTarget } from './pace-core';

/**
 * The Target pace field's prefill in s/km (E2E finding j): my saved target pace, else my usual pace, else null
 * (the field stays empty and its placeholder reads "e.g. 5:30", so it never looks like a filled value).
 */
export function initialPaceSec(target: PaceTarget, usual: number | null): number | null {
  return target.kind === 'pace' ? target.secPerKm : usual;
}

/** Save is enabled only when every field of the chosen mode has text; an empty field never reaches validation. */
export function targetFieldsFilled(mode: 'usual' | 'pace' | 'time', pace: string, km: string, time: string): boolean {
  if (mode === 'pace') return pace.trim() !== '';
  if (mode === 'time') return km.trim() !== '' && time.trim() !== '';
  return true;
}
