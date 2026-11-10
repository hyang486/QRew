import { useState } from 'react';

import { InkArt } from '@/components/ink-art';
import { QField, QScreen } from '@/components/q-screen';
import { Button, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { startAsGuest } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

// Qrew Q 02.01: "What's your name?", the display name field, who sees it, the gate art, and Join as guest
// pinned at the bottom (above the keyboard while typing). The name rule is unchanged (startAsGuest).
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
    <QScreen
      title={en.guest.title}
      bottom={<InkArt art="gate" width={170} />}
      bottomAlign="center"
      actions={
        <>
          {error && <Hint tone="error">{error}</Hint>}
          <Button title={en.guest.submit} onPress={submit} busy={busy} />
        </>
      }
    >
      <QField
        label={en.fields.name}
        value={name}
        onChangeText={setName}
        maxLength={40}
        autoFocus
        textContentType="nickname"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Hint>{en.guest.who}</Hint>
    </QScreen>
  );
}
