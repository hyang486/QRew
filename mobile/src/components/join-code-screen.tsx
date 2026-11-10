import { SymbolView } from 'expo-symbols';
import { useRouter } from 'expo-router';
import { type ComponentRef, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { InkArt } from '@/components/ink-art';
import { QCard, QScreen } from '@/components/q-screen';
import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { isValidCode, openInvite } from '@/lib/invite';

const CODE_LENGTH = 5;

// Qrew Q 02.03: "Find your room", five code boxes, the QR note card, the paper art, then See room / Scan QR
// code pinned at the bottom. One real text field sits over the boxes, so typing, paste and one-time-code
// autofill work as before. Signed in, See room opens the preview; signed out (route start/code, item 10), the
// code is held and the name step opens first (openInvite).
export function JoinCodeScreen() {
  const router = useRouter();
  const signedIn = !!useAuth().session;
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [code, setCode] = useState('');
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!isValidCode(code)) {
      setError(en.join.codeInvalid);
      return;
    }
    setError(null);
    openInvite({ code }, signedIn, {
      preview: (invite) => router.push({ pathname: '/preview', params: invite }),
      name: () => router.push('/guest'),
    });
  }

  return (
    <QScreen
      title={en.join.title}
      subtitle={en.join.subtitle}
      bottom={<InkArt art="paper" width={150} />}
      bottomAlign="center"
      actions={
        <>
          {error ? <Hint tone="error">{error}</Hint> : null}
          <Button title={en.join.submit} onPress={submit} disabled={code.length !== CODE_LENGTH} />
          <Button title={en.join.scan} variant="secondary" onPress={() => router.push(signedIn ? '/scan' : '/start/scan')} />
        </>
      }
    >
      <Pressable onPress={() => inputRef.current?.focus()} accessible={false} style={styles.boxesWrap}>
        <View style={styles.boxes} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {Array.from({ length: CODE_LENGTH }, (_, i) => {
            const active = focused && (i === code.length || (i === CODE_LENGTH - 1 && code.length === CODE_LENGTH));
            return (
              <View key={i} style={[styles.box, active && styles.boxActive]}>
                <Text style={[styles.digit, !code[i] && styles.placeholder]}>{code[i] ?? '–'}</Text>
              </View>
            );
          })}
        </View>
        <TextInput
          ref={inputRef}
          value={code}
          onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, CODE_LENGTH))}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          maxLength={CODE_LENGTH}
          autoFocus
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={submit}
          accessibilityLabel={en.join.codeLabel}
          caretHidden
          style={styles.hiddenInput}
        />
      </Pressable>

      <QCard row>
        <SymbolView name="bubble.left" size={22} tintColor={colors.label} />
        <View style={styles.noteText}>
          <Text style={styles.noteLine}>{en.join.qrNoteTitle}</Text>
          <Text style={styles.noteLine}>{en.join.qrNoteBody}</Text>
        </View>
      </QCard>
    </QScreen>
  );
}

const styles = StyleSheet.create({
  boxesWrap: { marginVertical: 8 },
  boxes: { flexDirection: 'row', gap: 8 },
  box: {
    flex: 1,
    aspectRatio: 1,
    maxHeight: 64,
    borderRadius: 10,
    borderCurve: 'continuous',
    backgroundColor: colors.field,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  boxActive: { borderColor: colors.tint },
  digit: { fontSize: 24, color: colors.label, fontVariant: ['tabular-nums'] },
  placeholder: { color: colors.secondaryLabel, fontSize: 18 },
  // Covers the boxes so a tap focuses it and the system can offer autofill; drawn invisible.
  hiddenInput: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.02, color: 'transparent' },
  noteText: { flex: 1, gap: 2 },
  noteLine: { fontSize: 14, color: colors.label },
});
