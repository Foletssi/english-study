/* POST /api/intake/challenge — broker a ticket handshake with the operator's
   own machine.

   Why a broker at all: the local intake service listens on loopback and must
   not accept requests from any web page that happens to guess the port. The
   flow is:

     page  -> this endpoint (authenticated as an admin)  -> challenge
     page  -> local service /v3/handshake with that challenge
     local -> this endpoint to verify the challenge      -> ticket

   The challenge is an HMAC over the admin id and a nonce, keyed by a server
   secret, so the local service cannot mint one for itself without having seen
   a genuine admin session first. */

import { HttpError, errorResponse, json, required } from '../../_lib/env.js';
import { requireAdmin } from '../../_lib/supabase.js';

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

async function sign(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  try {
    const { user } = await requireAdmin(env, request);
    const secret = required(env, 'INTAKE_HANDSHAKE_SECRET');

    const nonce = crypto.randomUUID();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + CHALLENGE_TTL_MS;
    const body = `${user.id}.${nonce}.${expiresAt}`;
    const signature = await sign(secret, body);

    return json({
      challenge: `${body}.${signature}`,
      adminId: user.id,
      expiresAt,
      intake: {
        // The local origin is configured per deployment; a hardcoded port in
        // shipped code is how the legacy ended up pinned to 8788/8789.
        url: env.INTAKE_PUBLIC_URL || 'http://127.0.0.1:8790/v3',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Shared by the local service to verify a challenge before minting a ticket. */
export async function onRequestPut({ request, env }) {
  try {
    const secret = required(env, 'INTAKE_HANDSHAKE_SECRET');
    const { challenge } = await request.json();
    const parts = String(challenge || '').split('.');
    if (parts.length !== 4) throw new HttpError(400, 'CHALLENGE_MALFORMED', '挑战串格式不正确');

    const [adminId, nonce, expiresRaw, signature] = parts;
    const expiresAt = Number(expiresRaw);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      throw new HttpError(401, 'CHALLENGE_EXPIRED', '验证已过期,请重新连接');
    }

    const expected = await sign(secret, `${adminId}.${nonce}.${expiresRaw}`);
    if (expected !== signature) throw new HttpError(401, 'CHALLENGE_INVALID', '验证失败');

    return json({ adminId, valid: true });
  } catch (error) {
    return errorResponse(error);
  }
}
