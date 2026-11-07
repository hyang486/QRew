import { HostAccountForm } from '@/components/host-account-form';
import { en } from '@/i18n/en';
import { signInHost } from '@/lib/auth';

export default function SignIn() {
  return (
    <HostAccountForm
      mode="sign-in"
      submitTitle={en.signIn.submit}
      onSubmit={({ email, password }) => signInHost(email, password)}
    />
  );
}
