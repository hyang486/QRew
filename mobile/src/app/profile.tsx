import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { QLink, QScreen } from '@/components/q-screen';
import { QRowCard } from '@/components/q-row-card';
import { Button, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { deleteAccount, signOut, useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

/**
 * Qrew unit 5 (Q 07.01): handwritten title, account cards, Language / Plus preview / Log out as rows and Delete
 * account as a red text button. Photo and name are edited on Edit profile (profile-edit).
 */
export default function Profile() {
  const { session, profile, isGuest } = useAuth();
  const [busy, setBusy] = useState<'signout' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = profile?.display_name ?? '';

  async function logOut() {
    setBusy('signout');
    setError(null);
    try {
      await signOut();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  async function runDelete() {
    setBusy('delete');
    setError(null);
    try {
      await deleteAccount();
    } catch {
      setError(en.profile.deleteFailed);
      setBusy(null);
    }
  }

  function confirmDelete() {
    Alert.alert(
      en.profile.deleteConfirmTitle,
      isGuest ? en.profile.deleteConfirmBody : en.profile.deleteConfirmHostBody,
      [
        { text: en.profile.deleteCancel, style: 'cancel' },
        { text: en.profile.deleteConfirmAction, style: 'destructive', onPress: runDelete },
      ],
    );
  }

  const editProfile = () => router.push('/profile-edit');

  return (
    <QScreen
      title={en.profile.title}
      subtitle={isGuest ? en.profile.guestAccount : en.profile.hostAccount}
      actions={
        isGuest ? (
          <>
            <Button title={en.profile.becomeHost} onPress={() => router.push('/upgrade')} />
            <Button title={en.profile.editProfile} variant="secondary" onPress={editProfile} />
          </>
        ) : (
          <Button title={en.profile.editProfile} variant="secondary" onPress={editProfile} />
        )
      }
    >
      <QRowCard
        leading={<Avatar path={profile?.avatar_path} name={name} size={36} />}
        title={name || '—'}
        subtitle={en.profile.nameLabel}
        accessibilityLabel={`${en.profile.nameLabel}: ${name}`}
      />
      {isGuest ? (
        <QRowCard icon="checkmark" title={en.profile.guestAccess} subtitle={en.profile.guestAccessBody} />
      ) : (
        <QRowCard
          icon="checkmark"
          title={en.profile.hostAccount}
          subtitle={session?.user.email ? `${session.user.email} · ${en.profile.hostAccessBody}` : en.profile.hostAccessBody}
        />
      )}

      <View style={styles.rows}>
        <QRowCard icon="globe" title={en.profile.language} value={en.profile.languageValue} />
        <QRowCard icon="sparkles" title={en.planPreview.profileLink} onPress={() => router.push('/plan-preview')} />
        <QRowCard
          icon="rectangle.portrait.and.arrow.right"
          title={en.profile.signOut}
          subtitle={isGuest ? en.profile.guestSignOutWarning : undefined}
          onPress={logOut}
          busy={busy === 'signout'}
        />
      </View>

      {error && <Hint tone="error">{error}</Hint>}

      <View style={styles.delete}>
        {busy === 'delete' ? (
          <ActivityIndicator accessibilityLabel={en.profile.deleteAccount} />
        ) : (
          <QLink title={en.profile.deleteAccount} tone="danger" onPress={confirmDelete} disabled={busy !== null} />
        )}
      </View>
    </QScreen>
  );
}

const styles = StyleSheet.create({
  rows: { gap: 8, marginTop: 8 },
  delete: { marginTop: 4, minHeight: 40, justifyContent: 'center' },
});
