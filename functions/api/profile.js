/* /api/profile — 学员自己的账号资料 (M01).

   GET   read the caller's profile
   PATCH update the editable fields

   Two fields are deliberately not writable here:

   - `role`      — the admin gate reads it on every admin call, so a learner
                   who could PATCH their own role would own the control end.
   - `vip_expires_at` — membership is granted through the invite-code flow or
                   by an operator in M09, never by the member themselves.

   The legacy exposed a single "update profile" endpoint that accepted any
   column the client sent, which meant those two were writable with curl. */

import { HttpError, errorResponse, json } from '../_lib/env.js';
import { createClient, requireUser } from '../_lib/supabase.js';
import { pick, trimmed } from '../_lib/fields.js';

const PROFILE_COLUMNS = [
  'id', 'display_name', 'phone', 'role', 'vip_expires_at', 'avatar_url',
  'invited_by_code', 'created_at', 'updated_at',
].join(',');

/** One shape for both the GET and the PATCH response, plus the derived fields
    the account page renders. `is_vip` is computed server-side from the same
    comparison the media route makes, so the badge and the playback gate can
    never disagree. */
function project(row) {
  const expiresAt = row.vip_expires_at ? new Date(row.vip_expires_at).getTime() : 0;
  return {
    id: row.id,
    display_name: row.display_name ?? null,
    phone: row.phone ?? null,
    role: row.role ?? 'learner',
    avatar_url: row.avatar_url ?? null,
    vip_expires_at: row.vip_expires_at ?? null,
    is_vip: Boolean(expiresAt && expiresAt > Date.now()),
    created_at: row.created_at ?? null,
  };
}

export async function onRequestGet({ request, env }) {
  try {
    const { user, token } = await requireUser(env, request);
    const client = createClient(env);
    // Read with the caller's own token: RLS is the thing that says this row is
    // theirs, and using the service role here would bypass that check.
    const rows = await client.select('profiles',
      `select=${PROFILE_COLUMNS}&id=eq.${encodeURIComponent(user.id)}&limit=1`, { key: token });
    const row = rows?.[0];
    if (!row) throw new HttpError(404, 'PROFILE_NOT_FOUND', '账号资料不存在');
    return json({ profile: project(row) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPatch({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const body = await request.json().catch(() => ({}));
    const client = createClient(env);

    const patch = { updated_at: new Date().toISOString() };

    if (pick(body, 'display_name') !== undefined) {
      const name = trimmed(pick(body, 'display_name'), 40);
      if (!name) throw new HttpError(400, 'DISPLAY_NAME_REQUIRED', '昵称不能为空');
      patch.display_name = name;
    }
    if (pick(body, 'avatar_url') !== undefined) {
      patch.avatar_url = trimmed(pick(body, 'avatar_url'), 500);
    }

    const [row] = await client.update('profiles', `id=eq.${encodeURIComponent(user.id)}`, patch);
    if (!row) throw new HttpError(404, 'PROFILE_NOT_FOUND', '账号资料不存在');
    return json({ profile: project(row) });
  } catch (error) {
    return errorResponse(error);
  }
}
