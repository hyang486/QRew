import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { Button, colors, Field, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { deleteAccount, signOut, updateDisplayName, useAuth } from '@/lib/auth';
import { avatarUrl, pickAvatar, removeProfilePhoto, setProfilePhoto } from '@/lib/avatar';
import { errorMessage } from '@/lib/errors';
import { authHeaders } from '@/lib/media';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text selectable style={styles.rowValue}>
        {value}
      </Text>
    </View>
  );
}

export default function Profile() {
  const { session, profile, isGuest, refreshProfile } = useAuth();
  // null until the user edits the field; until then it shows the stored name.
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? profile?.display_name ?? '';
  const [busy, setBusy] = useState<'save' | 'signout' | 'delete' | 'photo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    if (!session) return;
    setBusy('save');
    setError(null);
    setSaved(false);
    try {
      await updateDisplayName(session.user.id, name);
      await refreshProfile();
      setDraft(null);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

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

  async function changePhoto() {
    if (!session) return;
    setError(null);
    try {
      const uri = await pickAvatar();
      if (!uri) return;
      setBusy('photo');
      await setProfilePhoto(session.user.id, uri);
      await refreshProfile();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function clearPhoto() {
    if (!session) return;
    setBusy('photo');
    setError(null);
    try {
      await removeProfilePhoto(session.user.id);
      await refreshProfile();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
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

  return (
    <Screen>
      <View style={styles.photoRow}>
        {profile?.avatar_path && session ? (
          <Image
            accessibilityLabel={en.profile.photoLabel}
            style={styles.photo}
            source={{
              uri: avatarUrl(profile.avatar_path),
              headers: authHeaders(session.access_token),
              cacheKey: profile.avatar_path,
            }}
            cachePolicy="memory"
          />
        ) : (
          <View style={[styles.photo, styles.photoEmpty]}>
            <Text style={styles.initial}>{(profile?.display_name ?? '?').slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.photoActions}>
          <Button
            variant="secondary"
            title={profile?.avatar_path ? en.profile.changePhoto : en.profile.addPhoto}
            onPress={changePhoto}
            busy={busy === 'photo'}
          />
          {profile?.avatar_path && (
            <Button variant="secondary" title={en.profile.removePhoto} onPress={clearPhoto} disabled={busy !== null} />
          )}
        </View>
      </View>
      <Field
        label={en.profile.nameLabel}
        value={name}
        onChangeText={(t) => {
          setDraft(t);
          setSaved(false);
        }}
        maxLength={40}
      />
      <Button title={saved ? en.profile.saved : en.profile.save} onPress={save} busy={busy === 'save'} />

      <View style={styles.group}>
        <Row
          label={en.profile.accountType}
          value={isGuest ? en.profile.guest : `${en.profile.host} · ${session?.user.email ?? ''}`}
        />
        <Row label={en.profile.language} value={en.profile.languageValue} />
      </View>

      {isGuest && (
        <Button variant="secondary" title={en.profile.becomeHost} onPress={() => router.push('/upgrade')} />
      )}
      <Button variant="secondary" title={en.planPreview.profileLink} onPress={() => router.push('/plan-preview')} />

      {error && <Hint tone="error">{error}</Hint>}

      {isGuest && <Hint>{en.profile.guestSignOutWarning}</Hint>}
      <Button variant="destructive" title={en.profile.signOut} onPress={logOut} busy={busy === 'signout'} />
      <Button
        variant="destructive"
        title={en.profile.deleteAccount}
        onPress={confirmDelete}
        busy={busy === 'delete'}
        disabled={busy !== null}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  photo: { width: 72, height: 72, borderRadius: 36 },
  photoEmpty: { backgroundColor: colors.field, alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 28, fontWeight: '600', color: colors.secondaryLabel },
  photoActions: { flex: 1, gap: 8 },
  group: { backgroundColor: colors.field, borderRadius: 10, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    gap: 12,
  },
  rowLabel: { fontSize: 17, color: colors.label },
  rowValue: { fontSize: 17, color: colors.secondaryLabel, flexShrink: 1, textAlign: 'right' },
});
