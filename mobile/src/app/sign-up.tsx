import { HostAccountForm } from '@/components/host-account-form';
import { en } from '@/i18n/en';
import { signUpHost } from '@/lib/auth';

export default function SignUp() {
  return (
    <HostAccountForm
      mode="sign-up"
      submitTitle={en.signUp.submit}
      onSubmit={async ({ email, password, name }) => {
        const { needsConfirmation } = await signUpHost(email, password, name);
        if (needsConfirmation) return en.signUp.checkEmail;
      }}
    />
  );
}
