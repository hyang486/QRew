import AsyncStorage from '@react-native-async-storage/async-storage';

import { mergeSession, parseHistory, type PaceSession, type PaceTarget } from './pace-core';

// Spec 3.4 keys. All on this device only.
const HISTORY_KEY = 'qrewing.pace.v1.history';
const onKey = (roomId: string) => `qrewing.pace.v1.on.${roomId}`;
const TARGET_KEY = 'qrewing.pace.v1.target';

export async function loadHistory(): Promise<PaceSession[]> {
  try {
    return parseHistory(await AsyncStorage.getItem(HISTORY_KEY));
  } catch {
    return [];
  }
}

// Saves run one after another so two quick saves never drop each other's session. A failed read rejects without
// writing: writing then would replace the whole history with this one session.
let queue: Promise<unknown> = Promise.resolve();
export function saveSession(session: PaceSession): Promise<void> {
  const next = queue.then(async () => {
    const history = parseHistory(await AsyncStorage.getItem(HISTORY_KEY));
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(mergeSession(history, session)));
  });
  queue = next.catch(() => {});
  return next;
}

export async function getPaceOn(roomId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(onKey(roomId))) === '1';
  } catch {
    return false;
  }
}

export async function setPaceOn(roomId: string, on: boolean): Promise<void> {
  if (on) await AsyncStorage.setItem(onKey(roomId), '1');
  else await AsyncStorage.removeItem(onKey(roomId));
}

export async function getTarget(): Promise<PaceTarget> {
  try {
    const raw = await AsyncStorage.getItem(TARGET_KEY);
    const t = raw ? (JSON.parse(raw) as PaceTarget) : null;
    if (t?.kind === 'pace' && t.secPerKm > 0) return t;
    if (t?.kind === 'time' && t.distanceM > 0 && t.timeS > 0) return t;
  } catch {
    // Fall back to the usual pace.
  }
  return { kind: 'usual' };
}

export async function setTarget(target: PaceTarget): Promise<void> {
  await AsyncStorage.setItem(TARGET_KEY, JSON.stringify(target));
}
