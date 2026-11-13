// Spec 10.5: keeps the Siri Keychain item (siri-plan.ts contract) in step with the session and the active room.
// iOS only. Every failure is ignored: Siri then says to open Qrew, and the app itself never depends on the item.
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

import { activeRoomId, nextRoomChangeMs, SIRI_KEY, SIRI_SERVICE, type SiriRoom, siriMirrorValue, storedRoomId } from './siri-plan';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: SIRI_SERVICE,
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};
const URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const ANON = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

type Session = { access_token?: string; expires_at?: number } | null;

let started = false;
let session: Session = null;
/** null until the Rooms list was read in this run; the stored room is kept until then. */
let rooms: SiriRoom[] | null = null;
let lastOpened: string | null = null;
let roomId: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Writes run one after another, so an older value never lands after a newer one. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue(job: () => Promise<unknown>) {
  queue = queue.then(job).catch(() => {});
}

function write() {
  const value = siriMirrorValue(session, roomId, URL, ANON);
  enqueue(() => (value ? SecureStore.setItemAsync(SIRI_KEY, value, OPTIONS) : SecureStore.deleteItemAsync(SIRI_KEY, OPTIONS)));
}

/** Recomputes the active room from the known rooms, and re-arms for the next expiry while the app runs. */
function recompute() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!rooms) return;
  const now = Date.now();
  roomId = activeRoomId(rooms, lastOpened, now);
  const next = nextRoomChangeMs(rooms, now);
  // setTimeout caps at about 24.8 days; rooms last far less.
  if (next !== null) timer = setTimeout(() => {
    recompute();
    write();
  }, Math.min(next - now + 1000, 2 ** 31 - 1));
}

/** Once, at app start: mirrors every session change (sign-in, refresh, sign-out). */
export function startSiriMirror() {
  if (started || Platform.OS !== 'ios') return;
  started = true;
  // A restart keeps the room stored last time until the Rooms list is read again.
  enqueue(async () => {
    const stored = storedRoomId(await SecureStore.getItemAsync(SIRI_KEY, OPTIONS));
    if (rooms === null && roomId === null) {
      roomId = stored;
      lastOpened = lastOpened ?? stored;
    }
  });
  supabase.auth.onAuthStateChange((event, next) => {
    if (event === 'SIGNED_OUT' || !next) {
      session = null;
      rooms = null;
      lastOpened = null;
      roomId = null;
      if (timer) clearTimeout(timer);
      timer = undefined;
      enqueue(() => SecureStore.deleteItemAsync(SIRI_KEY, OPTIONS));
      return;
    }
    session = next;
    // Queued after the restore above, so the first write keeps the stored room.
    enqueue(async () => write());
  });
}

/** The Rooms list loaded: the only full view of my rooms (ended, expired and left ones are gone or closed). */
export function syncSiriRooms(list: readonly SiriRoom[]) {
  if (!started) return;
  rooms = list.map(({ id, deleted_at, expires_at, created_at }) => ({ id, deleted_at, expires_at, created_at }));
  recompute();
  write();
}

/** I opened this room (its chat). */
export function noteSiriRoomOpened(id: string) {
  if (!started) return;
  lastOpened = id;
  // A room joined since the list loaded is not in it yet: take it as is until the next list load.
  if (rooms?.some((r) => r.id === id)) recompute();
  else roomId = id;
  write();
}

/** I left this room, or ended it as host. */
export function noteSiriRoomClosed(id: string) {
  if (!started) return;
  if (lastOpened === id) lastOpened = null;
  if (rooms) {
    rooms = rooms.filter((r) => r.id !== id);
    recompute();
  } else if (roomId === id) {
    roomId = null;
  }
  write();
}
