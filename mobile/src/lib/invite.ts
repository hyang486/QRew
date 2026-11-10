// Pure invite helpers and the pending invite (no Expo or Supabase imports) so they can be tested in Node.
// rooms.ts re-exports the helpers.

export type Invite = { code: string } | { token: string };

const CODE_RE = /^[0-9]{5}$/;
const TOKEN_RE = /^[0-9a-f]{36}$/;

export function isValidCode(code: string) {
  return CODE_RE.test(code);
}

export function isValidToken(token: string) {
  return TOKEN_RE.test(token);
}

/** The URL encoded in the invite QR. Expo Router maps it to `src/app/join/[token].tsx`. */
export function inviteUrl(token: string) {
  return `moment://join/${token}`;
}

/** Reads an invite from a scanned QR payload. Returns null for anything that is not our invite. */
export function parseInvite(data: string): Invite | null {
  const text = data.trim();
  const match = /^moment:\/\/join\/([0-9a-f]+)$/i.exec(text);
  if (match && isValidToken(match[1].toLowerCase())) return { token: match[1].toLowerCase() };
  if (isValidCode(text)) return { code: text };
  return null;
}

/** True for a well-formed code or token invite. */
export function isValidInvite(invite: Invite) {
  return 'code' in invite ? isValidCode(invite.code) : isValidToken(invite.token);
}

// Pending invite. Item 10 (USER_DECISIONS:172, option A): a signed-out user joins as Join → code / QR / link → name →
// invite → Join. preview_room needs a session, so the invite chosen before sign-in is held here and
// opened right after sign-in (guest name or host login), from Rooms. No session is started for it.
//
// In memory only: a cold start by the invite link sets it again, and nothing about the invite outlives the
// app process. Leaving the name step keeps it (going back and signing in later still opens it); a newer
// invite replaces it; it is taken once, so it opens at most once.
let pending: Invite | null = null;

/** Holds `invite` until the next sign-in; a malformed invite is ignored. Returns whether it was kept. */
export function setPendingInvite(invite: Invite): boolean {
  const normalized: Invite = 'code' in invite ? { code: invite.code } : { token: invite.token.toLowerCase() };
  if (!isValidInvite(normalized)) return false;
  pending = normalized;
  return true;
}

/** Returns the pending invite once and clears it. */
export function takePendingInvite(): Invite | null {
  const invite = pending;
  pending = null;
  return invite;
}

export type InviteNav = {
  /** Signed in: open the invite preview. */
  preview(invite: Invite): void;
  /** Signed out: go to the name step. */
  name(): void;
};

/**
 * Where an invite chosen on the code screen, the scanner or a link goes next. Signed in, it opens the
 * preview directly. Signed out, it is held and the name step opens; Rooms opens it after sign-in.
 */
export function openInvite(invite: Invite, signedIn: boolean, nav: InviteNav) {
  if (signedIn) {
    nav.preview(invite);
    return;
  }
  setPendingInvite(invite);
  nav.name();
}

/** Rooms on focus: opens a held invite and returns true, at most once per invite. */
export function resumePendingInvite(preview: (invite: Invite) => void): boolean {
  const invite = takePendingInvite();
  if (!invite) return false;
  preview(invite);
  return true;
}
