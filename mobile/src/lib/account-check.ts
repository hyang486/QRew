// Pure account-validity classifier. No app imports, so it runs under `node --test` (see tests/).
//
// Signing out is irreversible for a guest (an anonymous user cannot sign back in), so only clear
// server evidence that the account is gone counts. Expired or skewed tokens, network errors and
// anything unexpected keep the stored session ('unknown').

export type AccountCheck = 'ok' | 'gone' | 'unknown';

export type AuthErrorLike = { status?: number; code?: string } | null | undefined;

export type AccountCheckDeps = {
  getUser: () => Promise<{ error: AuthErrorLike }>;
  refreshSession: () => Promise<{ error: AuthErrorLike }>;
  /** True for a server (AuthApiError) response; false for network/retryable/unknown errors. */
  isApiError: (error: NonNullable<AuthErrorLike>) => boolean;
};

/** Refresh failures that mean the server no longer has this user's session or refresh token. */
const GONE_ON_REFRESH = new Set(['refresh_token_not_found', 'session_not_found', 'user_not_found']);

function looksLikeBadToken(error: NonNullable<AuthErrorLike>) {
  return error.code === 'bad_jwt' || error.status === 401 || error.status === 403;
}

export async function checkAccount(deps: AccountCheckDeps): Promise<AccountCheck> {
  const first = await deps.getUser();
  if (!first.error) return 'ok';
  if (!deps.isApiError(first.error)) return 'unknown';
  if (first.error.code === 'user_not_found') return 'gone';
  if (!looksLikeBadToken(first.error)) return 'unknown';

  // Possibly just an expired or clock-skewed access token: refresh once and ask again.
  const refreshed = await deps.refreshSession();
  if (refreshed.error) {
    return deps.isApiError(refreshed.error) && GONE_ON_REFRESH.has(refreshed.error.code ?? '') ? 'gone' : 'unknown';
  }
  const second = await deps.getUser();
  if (!second.error) return 'ok';
  return deps.isApiError(second.error) && second.error.code === 'user_not_found' ? 'gone' : 'unknown';
}
