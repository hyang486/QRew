/**
 * G-1: runs a fetch for `key` and applies its result only if `key` is still the current key when
 * the fetch settles, so a slow fetch for an old filter cannot overwrite the newer filter's list.
 * Pure (no React) so the race can be tested.
 */
export type LoadOutcome<T> = { ok: true; data: T } | { ok: false; error: unknown };

export async function loadLatest<T>(
  key: string,
  currentKey: () => string,
  fetch: () => Promise<T>,
  apply: (outcome: LoadOutcome<T>) => void,
): Promise<'applied' | 'stale'> {
  let outcome: LoadOutcome<T>;
  try {
    outcome = { ok: true, data: await fetch() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (currentKey() !== key) return 'stale';
  apply(outcome);
  return 'applied';
}

/**
 * FG-L1: the same guard for repeated loads of one screen (focus, pull to refresh, after an action).
 * Each call gets a new key, so only the newest call's result is applied; an older response that
 * settles later (for example a focus load overtaken by a pull) is dropped.
 */
export function createLatestLoader() {
  let seq = 0;
  let current = '';
  return function run<T>(
    scope: string,
    fetch: () => Promise<T>,
    apply: (outcome: LoadOutcome<T>) => void,
  ): Promise<'applied' | 'stale'> {
    seq += 1;
    const key = `${scope}#${seq}`;
    current = key;
    return loadLatest(key, () => current, fetch, apply);
  };
}
