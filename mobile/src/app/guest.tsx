import { useState } from 'react';

import { Button, Field, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { startAsGuest } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

export default function Guest() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await startAsGuest(name);
      // The root layout's protected routes move a signed-in user to Rooms.
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Hint>{en.welcome.guestHint}</Hint>
      <Field
        label={en.guest.nameLabel}
        placeholder={en.guest.namePlaceholder}
        value={name}
        onChangeText={setName}
        maxLength={40}
        autoFocus
        textContentType="nickname"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      {error && <Hint tone="error">{error}</Hint>}
      <Button title={en.guest.submit} onPress={submit} busy={busy} />
    </Screen>
  );
}
