// On-device history of the private Qrewing chat (spec 10.1): AsyncStorage `qrewing.ask.v1.<roomId>`, last 30 turns,
// deleted when the room ends, expires or the user leaves. The server keeps no question or answer text.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { askKey, type AskTurn, parseHistory, staleAskKeys, trimHistory } from './ask-plan';

export async function loadAskHistory(roomId: string): Promise<AskTurn[]> {
  try {
    return parseHistory(await AsyncStorage.getItem(askKey(roomId)));
  } catch {
    return [];
  }
}

/** Adds one turn to the stored history (re-read first, so two screens never drop each other's turn). */
export async function appendAskTurn(roomId: string, turn: AskTurn): Promise<AskTurn[]> {
  const next = trimHistory([...(await loadAskHistory(roomId)), turn]);
  await AsyncStorage.setItem(askKey(roomId), JSON.stringify(next)).catch(() => {});
  return next;
}

/** The room ended, expired or I left: its history goes. Never throws. */
export async function purgeAskHistory(roomId: string): Promise<void> {
  await AsyncStorage.removeItem(askKey(roomId)).catch(() => {});
}

/** Deletes the history of every room that is not in `liveRoomIds` (expiry while the app was closed). Never throws. */
export async function purgeStaleAskHistories(liveRoomIds: readonly string[]): Promise<void> {
  try {
    const stale = staleAskKeys(await AsyncStorage.getAllKeys(), liveRoomIds);
    if (stale.length) await AsyncStorage.multiRemove(stale);
  } catch {
    // Kept until the next sweep.
  }
}
