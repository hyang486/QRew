import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { Button, colors, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import {
  enrollFace,
  type FaceEnrollment,
  faceRefUrl,
  loadFaceData,
  pickFaceReference,
  removeFaceEnrollment,
  runFaceMatch,
} from '@/lib/face';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; enrollment: FaceEnrollment | null; refUrl: string | null };

/**
 * Photos of me setup for one room: consent and reference photo, or (once enrolled) the private
 * reference with Replace and Stop and remove. Nothing is uploaded before "Agree and save".
 */
export default function FaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [replacing, setReplacing] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const { enrollment } = await loadFaceData(id, userId);
      const refUrl = enrollment ? await faceRefUrl(enrollment.ref_path) : null;
      setState({ status: 'ready', enrollment, refUrl });
    } catch (e) {
      setState({ status: 'error', message: errorMessage(e) });
    }
  }, [id, userId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function pick(source: 'camera' | 'library') {
    setMessage(null);
    try {
      const uri = await pickFaceReference(source);
      if (uri) setPicked(uri);
    } catch (e) {
      const text = errorMessage(e);
      setMessage(text === en.face.cameraDenied || source === 'library' ? text : en.face.cameraUnavailable);
    }
  }

  async function save() {
    if (!picked) {
      setMessage(en.face.chooseFirst);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await enrollFace(id, picked);
      if ('error' in result) {
        setMessage(result.error);
        return;
      }
      // FG-2: one run right after enrolling; the gallery shows its result (disabled while the switch is off).
      await runFaceMatch(id);
      router.back();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function confirmStop() {
    Alert.alert(en.face.stopTitle, en.face.stopBody, [
      { text: en.face.cancel, style: 'cancel' },
      {
        text: en.face.stopConfirm,
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          const result = await removeFaceEnrollment(id);
          setBusy(false);
          if ('error' in result) {
            setMessage(result.error ?? null);
            return;
          }
          router.back();
        },
      },
    ]);
  }

  if (state.status === 'loading') {
    return (
      <Screen>
        <ActivityIndicator style={styles.loading} />
      </Screen>
    );
  }
  if (state.status === 'error') {
    return (
      <Screen>
        <Hint tone="error">{state.message}</Hint>
        <Button title={en.home.retry} variant="secondary" onPress={load} />
      </Screen>
    );
  }

  if (state.enrollment && !replacing) {
    return (
      <Screen>
        <Text style={styles.sectionTitle}>{en.face.referenceTitle}</Text>
        {state.refUrl ? (
          <Image source={{ uri: state.refUrl }} style={styles.preview} contentFit="cover" accessibilityLabel={en.face.referenceTitle} />
        ) : null}
        <Hint>{en.face.referenceHint}</Hint>
        {message ? <Hint tone="error">{message}</Hint> : null}
        <Button
          title={en.face.replace}
          variant="secondary"
          disabled={busy}
          onPress={() => {
            setPicked(null);
            setMessage(null);
            setReplacing(true);
          }}
        />
        <Button title={en.face.stop} variant="destructive" busy={busy} onPress={confirmStop} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Text style={styles.title} accessibilityRole="header">
        {en.face.consentTitle}
      </Text>
      <View style={styles.points}>
        {en.face.consentPoints.map((p) => (
          <Text key={p} style={styles.point}>
            • {p}
          </Text>
        ))}
      </View>
      {picked ? <Image source={{ uri: picked }} style={styles.preview} contentFit="cover" /> : null}
      <Button title={en.face.takePhoto} variant="secondary" disabled={busy} onPress={() => pick('camera')} />
      <Button title={en.face.choosePhoto} variant="secondary" disabled={busy} onPress={() => pick('library')} />
      {message ? <Hint tone="error">{message}</Hint> : null}
      {busy ? <Hint>{en.face.saving}</Hint> : null}
      <Button title={en.face.agree} busy={busy} disabled={!picked} onPress={save} />
      {replacing ? (
        <Button title={en.face.cancel} variant="secondary" disabled={busy} onPress={() => setReplacing(false)} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  title: { fontSize: 22, fontWeight: '700', color: colors.label },
  points: { gap: 8 },
  point: { fontSize: 15, lineHeight: 21, color: colors.label },
  sectionTitle: { fontSize: 13, color: colors.secondaryLabel, textTransform: 'uppercase' },
  preview: { width: 180, height: 180, borderRadius: 12, alignSelf: 'center', backgroundColor: colors.field },
});
