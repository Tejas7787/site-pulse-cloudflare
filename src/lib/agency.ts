// ── Phase 6: agency workspace policy ─────────────────────────────────────────
// Pure module: workspace limits, client/branding normalization, invite
// lifetime. Shared verbatim by the Convex handlers and the tests — no I/O and
// no Convex imports, exactly like src/lib/monitoring.ts.
//
// Email shape validation is deliberately NOT duplicated here: the Convex
// handlers reuse the existing isValidAlertEmail() from src/lib/alerts.ts.

export const MAX_AGENCY_NAME = 80;
export const MAX_CLIENT_NAME = 120;
export const MAX_CLIENT_CONTACT = 120;
export const MAX_CLIENT_NOTES = 2_000;

// Bounds chosen so the dashboard query stays a handful of indexed reads per
// client and can never turn into an unbounded fan-out. Raising these later is
// a deliberate product decision, not a hotfix.
export const MAX_CLIENTS_PER_AGENCY = 20;
export const MAX_WEBSITES_PER_CLIENT = 10;
export const MAX_MEMBERS_PER_AGENCY = 10;
export const MAX_PENDING_INVITES = 25;

/** Invitations expire; an invite nobody accepted is dead after this. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Collapse whitespace and trim; null when empty or too long. */
function normalizeName(raw: string, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > maxLength) return null;
  return name;
}

export function normalizeAgencyName(raw: string): string | null {
  return normalizeName(raw, MAX_AGENCY_NAME);
}

export function normalizeClientName(raw: string): string | null {
  return normalizeName(raw, MAX_CLIENT_NAME);
}

export function normalizeClientContact(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const contact = raw.trim().replace(/\s+/g, " ");
  if (contact.length === 0) return null; // empty means "clear the field"
  return contact.length > MAX_CLIENT_CONTACT ? null : contact;
}

export function normalizeClientNotes(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const notes = raw.trim();
  if (notes.length > MAX_CLIENT_NOTES) return null;
  return notes; // "" means "clear the field"
}

/**
 * Branding logo: a plain http(s) URL, nothing else. javascript:, data: and
 * blob: URLs are rejected outright — this value is rendered as an <img src>
 * inside the workspace, so it must never be able to execute or embed
 * arbitrary content.
 */
export function normalizeLogoUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (url.length === 0 || url.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

/** The invite link an owner copies to the invitee. The token is a secret. */
export function inviteUrl(origin: string, token: string): string {
  const base = origin.trim().replace(/\/+$/, "");
  return `${base}/agency?invite=${encodeURIComponent(token)}`;
}

/** True when an invite is still waiting: not accepted, not revoked, not expired. */
export function isInvitePending(invite: {
  acceptedAt?: number;
  revokedAt?: number;
  expiresAt: number;
}, now: number): boolean {
  return invite.acceptedAt === undefined && invite.revokedAt === undefined && invite.expiresAt > now;
}
