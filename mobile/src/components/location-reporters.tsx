import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import {
  dropConsent,
  setSharingState,
  useLocationReporter,
  useMyShare,
  useSharingRooms,
} from '@/lib/location';
import { useRoomEvents } from '@/lib/room-channel';
import { getRoom } from '@/lib/rooms';

/**
 * M2: mounted once in the root layout. Runs one foreground reporter per room the user opted into
 * during this app run, so sharing keeps going while the user is in chat or any other screen. The
 * map screen only reads the sharing store. Sign-out / stopMyLocation empties the set, which
 * unmounts every reporter.
 */
export function LocationReporters() {
  const { session } = useAuth();
  const rooms = useSharingRooms();
  const userId = session?.user.id;
  if (!userId) return null;
  return (
    <>
      {[...rooms].map((roomId) => (
        <RoomReporter key={roomId} roomId={roomId} userId={userId} />
      ))}
    </>
  );
}

function RoomReporter({ roomId, userId }: { roomId: string; userId: string }) {
  const [active, setActive] = useState(false);
  const my = useMyShare(roomId, userId);

  const loadRoom = useCallback(async () => {
    try {
      const room = await getRoom(roomId);
      setActive(!!room && room.location_allowed && room.activity_state === 'active');
    } catch {
      // Keep the last known value; the server refuses reports that no longer apply.
    }
  }, [roomId]);

  useEffect(() => {
    // loadRoom only sets state after its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRoom();
  }, [loadRoom]);

  useRoomEvents(
    roomId,
    (event) => {
      if (event.table === 'rooms') loadRoom();
    },
    (status) => {
      if (status === 'SUBSCRIBED') loadRoom();
    },
  );

  const state = useLocationReporter({
    roomId,
    enabled: active && my.share,
    onRefused: () => {
      setSharingState(roomId, 'refused');
      my.reload();
    },
    onPermissionLost: () => {
      // The reporter already called stopMyLocation (L1), which cleared every room's consent.
      setSharingState(roomId, 'no-permission');
      dropConsent(roomId);
    },
  });

  useEffect(() => {
    setSharingState(roomId, state);
  }, [roomId, state]);

  // Opt-out or sign-out unmounts this reporter. 'off' never hides a 'refused' / 'no-permission'.
  useEffect(() => () => setSharingState(roomId, 'off'), [roomId]);

  return null;
}
