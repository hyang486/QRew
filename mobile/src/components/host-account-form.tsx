import { router } from 'expo-router';
import { type ComponentRef, useRef, useState } from 'react';
import { type TextInput, View } from 'react-native';

import { InkArt } from '@/components/ink-art';
import { QField, QLink, QScreen } from '@/components/q-screen';
import { Button, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { errorMessage } from '@/lib/errors';

type Props = {
  mode: 'sign-in' | 'sign-up' | 'upgrade';
  hint?: string;
  submitTitle: string;
  initialName?: string;
  /** Returns a message to show on success without navigating (e.g. "check your email"). */
  onSubmit: (values: { email: string; password: string; name: string }) => Promise<string | void>;
};

/**
 * Qrew host account screens. Log in (Q 01.02): "Host login", one line, email and password, Log in, then "New
 * here? Create an account". Sign up and guest upgrade (Q 07.02): "Become a host", one line, the gate art, name,
 * email, password, Create host account. No social buttons (human decision 1). Buttons sit under the fields, as
 * in Q; validation, errors and the upgrade path are unchanged.
 */
export function HostAccountForm({ mode, hint, submitTitle, initialName = '', onSubmit }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const emailRef = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordRef = useRef<ComponentRef<typeof TextInput>>(null);
  // K2: the submit button stays in view with the focused field while typing (QScreen keepVisible).
  const submitRef = useRef<ComponentRef<typeof View>>(null);
  const isNew = mode !== 'sign-in';

  async function submit() {
    if (!email.trim() || !password) {
      setError(en.errors.emailPasswordRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const message = await onSubmit({ email, password, name });
      if (message) setNotice(message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <QScreen
      title={isNew ? en.hostAccount.newTitle : en.hostAccount.loginTitle}
      subtitle={isNew ? en.hostAccount.newSubtitle : en.hostAccount.loginSubtitle}
      keepVisible={submitRef}
    >
      {isNew ? <InkArt art="gate" width={150} /> : null}
      {isNew && (
        <QField
          label={en.fields.name}
          value={name}
          onChangeText={setName}
          maxLength={40}
          textContentType="nickname"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => emailRef.current?.focus()}
        />
      )}
      <QField
        ref={emailRef}
        label={en.fields.email}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType={isNew ? 'username' : 'emailAddress'}
        autoComplete="email"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordRef.current?.focus()}
      />
      <QField
        ref={passwordRef}
        label={isNew ? `${en.fields.password} (${en.fields.passwordHint.toLowerCase()})` : en.fields.password}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType={isNew ? 'newPassword' : 'password'}
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      {error && <Hint tone="error">{error}</Hint>}
      {notice && <Hint>{notice}</Hint>}
      <View ref={submitRef} collapsable={false}>
        <Button title={submitTitle} onPress={submit} busy={busy} />
      </View>
      {hint && <Hint>{hint}</Hint>}
      {mode === 'sign-in' ? <QLink title={en.hostAccount.createAccount} onPress={() => router.push('/sign-up')} /> : null}
    </QScreen>
  );
}
