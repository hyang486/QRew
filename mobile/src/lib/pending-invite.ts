// Holds a QR invite that was opened before the user had a session (spec: keep the invite
// through guest start or host auth, then return to it). In memory only: a cold start by the
// invite link sets it again, and nothing about the invite outlives the app process.
let pendingToken: string | null = null;

export function setPendingInvite(token: string) {
  pendingToken = token;
}

/** Returns the pending token once and clears it. */
export function takePendingInvite() {
  const token = pendingToken;
  pendingToken = null;
  return token;
}
