import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';

import { LocationReporters } from '@/components/location-reporters';
import { en } from '@/i18n/en';
import { AuthProvider, useAuth } from '@/lib/auth';
import { reminderRoomFromResponse, setPendingReminderRoom } from '@/lib/expiry-reminders';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { session, loading } = useAuth();
  const signedIn = !!session;

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync();
  }, [loading]);

  // A tapped expiry reminder (also one that cold-started the app) opens its room. The room screen
  // checks access and shows the ended notice if the room is gone. Signed out: held until sign-in.
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (loading) return;
    const roomId = reminderRoomFromResponse(response);
    if (!roomId) return;
    Notifications.clearLastNotificationResponse();
    if (signedIn) router.push({ pathname: '/room/[id]', params: { id: roomId, from: 'reminder' } });
    else setPendingReminderRoom(roomId);
  }, [response, loading, signedIn, router]);

  if (loading) return null;

  return (
    <>
    <LocationReporters />
    <Stack screenOptions={{ headerLargeTitle: false, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Protected guard={signedIn} redirectTo="/welcome">
        <Stack.Screen name="index" options={{ title: en.home.title, headerLargeTitle: true }} />
        <Stack.Screen name="profile" options={{ title: en.profile.title }} />
        <Stack.Screen name="upgrade" options={{ title: en.upgrade.title, presentation: 'modal' }} />
        <Stack.Screen name="plan-preview" options={{ title: en.planPreview.title }} />
        <Stack.Screen name="create-room" options={{ title: en.createRoom.title }} />
        <Stack.Screen name="join/index" options={{ title: en.join.title }} />
        <Stack.Screen name="scan" options={{ title: en.scan.title }} />
        <Stack.Screen name="preview" options={{ title: en.preview.title }} />
        <Stack.Screen name="room/[id]/index" options={{ title: '' }} />
        <Stack.Screen name="room/[id]/info" options={{ title: en.room.info }} />
        <Stack.Screen name="room/[id]/gallery" options={{ title: en.media.title }} />
        <Stack.Screen name="room/[id]/map" options={{ title: en.map.title }} />
        <Stack.Screen name="room/[id]/face" options={{ title: en.face.title }} />
        <Stack.Screen name="room/[id]/media/[mediaId]" options={{ title: '' }} />
        <Stack.Screen name="room/[id]/invite" options={{ title: en.invite.title, presentation: 'modal' }} />
      </Stack.Protected>

      {/* QR deep link moment://join/<token>; handles both signed-in and signed-out users. */}
      <Stack.Screen name="join/[token]" options={{ headerShown: false }} />

      <Stack.Protected guard={!signedIn} redirectTo="/">
        <Stack.Screen name="welcome" options={{ title: en.appName, headerShown: false }} />
        <Stack.Screen name="guest" options={{ title: en.guest.title }} />
        <Stack.Screen name="sign-in" options={{ title: en.signIn.title }} />
        <Stack.Screen name="sign-up" options={{ title: en.signUp.title }} />
      </Stack.Protected>
    </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
