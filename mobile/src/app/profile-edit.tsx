import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { QField, QScreen } from '@/components/q-screen';
import { Button, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { updateDisplayName, useAuth } from '@/lib/auth';
import { pickAvatar, removeProfilePhoto, setProfilePhoto } from '@/lib/avatar';
import { errorMessage } from '@/lib/errors';

/** Qrew unit 5 (Q 07.01 Edit profile): profile photo and display name, moved here from Profile unchanged. */
export default function ProfileEdit() {
  const { session, profile, refreshProfile } = useAuth();
  // null until the user edits the field; until then it shows the stored name.
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? profile?.display_name ?? '';
  const [busy, setBusy] = useState<'save' | 'photo' | null>(null);
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

  return (
    <QScreen
      title={en.profile.editProfile}
      subtitle={en.profile.editProfileHint}
      actions={<Button title={saved ? en.profile.saved : en.profile.save} onPress={save} busy={busy === 'save'} />}
    >
      <View style={styles.photoRow}>
        <Avatar path={profile?.avatar_path} name={profile?.display_name ?? '?'} size={72} />
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
      <QField
        label={en.profile.nameLabel}
        value={name}
        onChangeText={(t) => {
          setDraft(t);
          setSaved(false);
        }}
        maxLength={40}
      />
      {error && <Hint tone="error">{error}</Hint>}
    </QScreen>
  );
}

const styles = StyleSheet.create({
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  photoActions: { flex: 1, gap: 8 },
});
