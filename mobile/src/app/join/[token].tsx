import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '@/lib/auth';
import { setPendingInvite } from '@/lib/invite';

// Entry point for the QR deep link `moment://join/<token>`. Signed in, it opens the preview. Signed out (item
// 10, option A), the invite is held and the name step opens over Welcome, cold or warm: `dismissTo` pops back to
// Welcome when it is in the stack, or replaces this screen with it; Rooms opens the invite after sign-in.
export default function InviteLink() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { session } = useAuth();
  const router = useRouter();
  const normalized = (token ?? '').toLowerCase();
  const signedIn = !!session;

  useEffect(() => {
    if (signedIn) return;
    const held = setPendingInvite({ token: normalized });
    router.dismissTo('/welcome');
    // A malformed token is not held: Welcome only, as before.
    if (held) router.push('/guest');
  }, [signedIn, normalized, router]);

  if (!signedIn) return null;
  // An unknown token still goes to preview, which shows the invalid-invite message.
  return <Redirect href={{ pathname: '/preview', params: { token: normalized } }} />;
}
