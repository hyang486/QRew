import { useState } from 'react';

import { Button, Field, Hint, Screen } from '@/components/ui';
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

export function HostAccountForm({ mode, hint, submitTitle, initialName = '', onSubmit }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    <Screen>
      {hint && <Hint>{hint}</Hint>}
      {isNew && (
        <Field
          label={en.fields.name}
          value={name}
          onChangeText={setName}
          maxLength={40}
          textContentType="nickname"
        />
      )}
      <Field
        label={en.fields.email}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType={isNew ? 'username' : 'emailAddress'}
        autoComplete="email"
      />
      <Field
        label={en.fields.password}
        placeholder={isNew ? en.fields.passwordHint : undefined}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType={isNew ? 'newPassword' : 'password'}
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      {error && <Hint tone="error">{error}</Hint>}
      {notice && <Hint>{notice}</Hint>}
      <Button title={submitTitle} onPress={submit} busy={busy} />
    </Screen>
  );
}
