import { useEffect, useSyncExternalStore } from 'react';

import type { PaceSession, PaceTarget } from './pace-core';
import { getPaceOn, getTarget, loadHistory, setPaceOn, setTarget } from './storage';

/** The switch per room, the target and the history, shared by the Map card and PaceLayer. */
type Settings = {
  on: Map<string, boolean>;
  target: PaceTarget | null;
  history: PaceSession[] | null;
};
let settings: Settings = { on: new Map(), target: null, history: null };
const listeners = new Set<() => void>();
function update(next: Partial<Settings>) {
  settings = { ...settings, ...next };
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function usePaceSettings(roomId: string) {
  const s = useSyncExternalStore(subscribe, () => settings);
  useEffect(() => {
    if (!settings.on.has(roomId)) {
      getPaceOn(roomId).then((on) => {
        if (!settings.on.has(roomId)) update({ on: new Map(settings.on).set(roomId, on) });
      });
    }
    if (!settings.target) getTarget().then((target) => update({ target }));
    if (!settings.history) reloadHistory();
  }, [roomId]);
  return {
    on: s.on.get(roomId) ?? false,
    target: s.target ?? { kind: 'usual' as const },
    history: s.history ?? [],
  };
}

export function reloadHistory() {
  loadHistory().then((history) => update({ history }));
}

export async function setOn(roomId: string, on: boolean) {
  update({ on: new Map(settings.on).set(roomId, on) });
  await setPaceOn(roomId, on);
}

export async function saveTarget(target: PaceTarget) {
  update({ target });
  await setTarget(target);
}
