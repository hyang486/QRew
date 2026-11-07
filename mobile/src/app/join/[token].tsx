import { Redirect, useLocalSearchParams } from 'expo-router';

import { useAuth } from '@/lib/auth';
import { setPendingInvite } from '@/lib/pending-invite';
import { isValidToken } from '@/lib/rooms';

// Entry point for the QR deep link `moment://join/<token>`. Signed-out users keep the invite
// through guest start or host auth; the Rooms screen resumes it afterwards.
export default function InviteLink() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { session } = useAuth();
  const normalized = (token ?? '').toLowerCase();

  if (!session) {
    if (isValidToken(normalized)) setPendingInvite(normalized);
    return <Redirect href="/welcome" />;
  }
  // An unknown token still goes to preview, which shows the invalid-invite message.
  return <Redirect href={{ pathname: '/preview', params: { token: normalized } }} />;
}
