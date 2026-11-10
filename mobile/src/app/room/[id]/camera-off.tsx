import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking } from 'react-native';

import { InkArt } from '@/components/ink-art';
import { QScreen } from '@/components/q-screen';
import { RoomEnded } from '@/components/room-ended';
import { Button } from '@/components/ui';
import { en } from '@/i18n/en';
import { addToRoom } from '@/lib/add-media';
import { useAuth } from '@/lib/auth';
import { pickPhotosAndVideos } from '@/lib/media';
import { confirmOriginalsNotice } from '@/lib/originals-notice';
import { useRoomEvents } from '@/lib/room-channel';
import { getRoom, type Room } from '@/lib/rooms';
import { useRoomOver } from '@/lib/use-room-over';

/**
 * Q 07.04 "Camera access is off": pushed from Photos & files when Take a photo finds camera access off (it was
 * an alert). Open Settings goes to the app's Settings page; Choose from library runs the gallery's photo picker
 * path (originals notice, size check, upload queue) and returns to the gallery once something is added.
 * Art: no camera drawing exists yet, so the group art (Q 01.04 gathering) stands in.
 */
export default function CameraOffScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [busy, setBusy] = useState(false);
  // G-U6-1: Choose from library uploads into the room, so a room that ended or expired shows Room ended.
  // 'unknown' until read (or when the read fails): the screen shows as before and an upload error says why.
  const [room, setRoom] = useState<Room | null | 'unknown'>('unknown');
  const readRoom = useCallback(() => {
    getRoom(id)
      .then(setRoom)
      .catch(() => undefined);
  }, [id]);
  useFocusEffect(readRoom);
  useRoomEvents(id, (event) => {
    if (event.table === 'rooms' || event.table === 'room_members') readRoom();
  });
  const ended = useRoomOver(room === 'unknown' ? null : room);

  async function chooseFromLibrary() {
    setBusy(true);
    try {
      if (!(await confirmOriginalsNotice())) return;
      const result = await addToRoom(id, session?.user.id, pickPhotosAndVideos);
      if (result === 'added' && router.canGoBack()) router.back();
    } finally {
      setBusy(false);
    }
  }

  if (room === null || ended.over) {
    return (
      <>
        <Stack.Screen options={{ title: '', headerTitle: '' }} />
        <RoomEnded room={room === 'unknown' ? null : room} nowMs={ended.nowMs} />
      </>
    );
  }

  return (
    <QScreen
      title={en.cameraOff.title}
      subtitle={en.cameraOff.body}
      bottomAlign="center"
      bottom={<InkArt art="camera" width={220} />}
      actions={
        <>
          <Button title={en.cameraOff.openSettings} onPress={() => Linking.openSettings()} />
          <Button title={en.cameraOff.chooseLibrary} variant="secondary" busy={busy} onPress={chooseFromLibrary} />
        </>
      }
    >
      <Stack.Screen options={{ title: en.cameraOff.title, headerTitle: '' }} />
    </QScreen>
  );
}
