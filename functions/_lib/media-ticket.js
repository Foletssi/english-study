/* Eastudy V3 — playback ticket signing and verification.

   Split out of the media route because two different functions need the same
   primitives: /api/media/ticket mints a ticket, /api/media/* verifies one, and
   the subtitle route reuses the same scope check. Keeping the crypto in one
   module means there is exactly one implementation of "is this ticket valid",
   which is the sort of thing that quietly diverges when it is copy-pasted.

   The ticket is an HMAC-SHA256 over a base64url JSON payload. It is not a JWT
   because nothing else needs to read it and a shorter URL is worth more here:
   every HLS segment URL carries a copy. */

import { HttpError } from './env.js';

export const TICKET_TTL_SECONDS = 6 * 60 * 60;   // a long study session
export const RENEW_MARGIN_SECONDS = 10 * 60;

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function signTicket(secret, claims) {
  if (!secret) throw new HttpError(500, 'CONFIG_MISSING', '缺少环境变量 PLAYBACK_TICKET_SECRET');
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(signature))}`;
}

export async function verifyTicket(secret, ticket) {
  const [payload, signature] = String(ticket || '').split('.');
  if (!payload || !signature) throw new HttpError(401, 'TICKET_MALFORMED', '播放凭证无效');
  if (!secret) throw new HttpError(500, 'CONFIG_MISSING', '缺少环境变量 PLAYBACK_TICKET_SECRET');

  const key = await importKey(secret);
  // verify() is constant-time; comparing signatures by hand would not be.
  const ok = await crypto.subtle.verify('HMAC', key, unb64url(signature), new TextEncoder().encode(payload));
  if (!ok) throw new HttpError(401, 'TICKET_INVALID', '播放凭证无效');

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    throw new HttpError(401, 'TICKET_MALFORMED', '播放凭证无效');
  }
  if (!claims?.exp || Date.now() / 1000 > claims.exp) {
    throw new HttpError(401, 'TICKET_EXPIRED', '播放凭证已过期');
  }
  return claims;
}

/** Build the claims for one video. The prefix is inside the signature, not a
    parameter beside it: a ticket minted for video A must not be able to name
    video B's prefix and fetch it. */
export function ticketClaims({ subject, videoId, jobId, prefix }) {
  return {
    sub: subject,
    vid: videoId,
    job: jobId || null,
    prefix,
    exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS,
  };
}

/** Normalise an R2 prefix to the form the client stores, without a leading or
    trailing slash, so `startsWith` scoping cannot be defeated by `//`. */
export function normalizePrefix(prefix) {
  return String(prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Scope check shared by the segment route and the subtitle route. */
export function assertInScope(claims, key) {
  const prefix = normalizePrefix(claims.prefix);
  const target = normalizePrefix(key);
  if (!prefix || !(target === prefix || target.startsWith(`${prefix}/`))) {
    throw new HttpError(403, 'TICKET_SCOPE', '播放凭证与请求资源不匹配');
  }
}

export function playlistUrl(prefix, ticket) {
  return `/api/media/${normalizePrefix(prefix)}/master.m3u8?ticket=${encodeURIComponent(ticket)}`;
}

export function subtitlesUrl(prefix, ticket) {
  return `/api/media/subtitles/${encodeURIComponent(normalizePrefix(prefix))}?ticket=${encodeURIComponent(ticket)}`;
}
