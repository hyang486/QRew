// Fake `ask` backend (spec 10.6: the client is built against the 10.3 contract before the server action ships).
// On only with EXPO_PUBLIC_QREWING_ASK_FAKE=1 in .env.local (restart Metro with --clear). A question containing
// "#consent", "#limit", "#fail" or "#offline" answers with that error so every screen state can be checked.
import { askBody } from './ask-plan';
import type { Invoke } from './qrewing-api';

export const ASK_FAKE = process.env.EXPO_PUBLIC_QREWING_ASK_FAKE === '1';

const ERRORS = [
  ['#consent', 'not_consented'],
  ['#limit', 'ask_limit'],
  ['#fail', 'ai_failed'],
  ['#offline', 'network'],
] as const;

export async function fakeAskInvoke(body: ReturnType<typeof askBody>): Promise<Invoke<unknown>> {
  await new Promise((r) => setTimeout(r, 900));
  const question = String(body.question ?? '');
  const hit = ERRORS.find(([tag]) => question.includes(tag));
  if (hit) return { error: hit[1] };
  const turns = Array.isArray(body.history) ? body.history.length : 0;
  return {
    data: {
      answer: `(Test answer) You asked: "${question}". I can see ${turns} earlier turn${turns === 1 ? '' : 's'}.`,
      usage: { input: 0, output: 0 },
    },
  };
}
