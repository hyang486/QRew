import { router } from 'expo-router';

import { InkArt } from '@/components/ink-art';
import { QScreen } from '@/components/q-screen';
import { Button, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';

// Qrew Q 01.01: title, one line, gathering art, then Join a room / Create a room. Join opens the code screen
// (item 10: code / QR → name → invite);
// Create goes to host login, which links to host sign-up ("New here? Create an account").
export default function Welcome() {
  const { notice, clearNotice } = useAuth();
  function go(path: '/start/code' | '/sign-in') {
    clearNotice();
    router.push(path);
  }
  return (
    <QScreen
      title={en.appName}
      subtitle={en.welcome.tagline}
      bottom={<InkArt art="gathering" width={200} />}
      bottomAlign="center"
      actions={
        <>
          {notice ? <Hint tone="error">{notice}</Hint> : null}
          <Button title={en.welcome.join} onPress={() => go('/start/code')} />
          <Button variant="secondary" title={en.welcome.create} onPress={() => go('/sign-in')} />
        </>
      }
    />
  );
}
