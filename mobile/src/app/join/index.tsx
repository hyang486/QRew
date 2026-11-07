import { useRouter } from 'expo-router';
import { useState } from 'react';

import { Button, Field, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { isValidCode } from '@/lib/rooms';

export default function JoinByCode() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!isValidCode(code)) {
      setError(en.join.codeInvalid);
      return;
    }
    setError(null);
    router.push({ pathname: '/preview', params: { code } });
  }

  return (
    <Screen>
      <Field
        label={en.join.codeLabel}
        placeholder={en.join.codePlaceholder}
        value={code}
        onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 5))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        maxLength={5}
        autoFocus
        onSubmitEditing={submit}
      />
      {error ? <Hint tone="error">{error}</Hint> : null}
      <Button title={en.join.submit} onPress={submit} disabled={code.length !== 5} />
      <Button title={en.join.scan} variant="secondary" onPress={() => router.push('/scan')} />
    </Screen>
  );
}
