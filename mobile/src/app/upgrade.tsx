import { router } from 'expo-router';

import { HostAccountForm } from '@/components/host-account-form';
import { en } from '@/i18n/en';
import { upgradeGuestToHost, useAuth } from '@/lib/auth';

export default function Upgrade() {
  const { profile, refreshProfile } = useAuth();
  return (
    <HostAccountForm
      mode="upgrade"
      hint={en.upgrade.hint}
      submitTitle={en.upgrade.submit}
      initialName={profile?.display_name ?? ''}
      onSubmit={async ({ email, password, name }) => {
        await upgradeGuestToHost(email, password, name);
        await refreshProfile();
        router.back();
      }}
    />
  );
}
