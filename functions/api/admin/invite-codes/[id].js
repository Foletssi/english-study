/* DELETE /api/admin/invite-codes/:code — 作废邀请码 (M09).

   Addressed by the code itself, not by a row id. The client's 作废 button comes
   off a table whose `rowKey` is `row.code` and whose service method is
   `revokeInviteCode(row.code)`, and the confirm dialog quotes the code back to
   the operator ("作废后「XXXX」将无法再被兑换"). Matching that in the route means
   a code pasted from a support ticket addresses the same row the table showed.

   This is a soft delete. `used_count` may be above zero, and a code that has
   already brought someone in is part of that learner's history — the profile
   still records `invited_by_code`. Deleting the row would leave that column
   pointing at nothing, and the 学员 table's 邀请码 column would go blank for a
   learner nobody changed. Revoking keeps the record and stops further use,
   which is what the button promises. */

import { HttpError, errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';

function codeFrom(params) {
  const raw = params?.id;
  const code = Array.isArray(raw) ? raw[0] : raw;
  if (!code) throw new HttpError(400, 'CODE_REQUIRED', '缺少邀请码');
  // Uppercased to match redemption, which uppercases what the learner typed.
  // Without this, revoking a code typed in lowercase would 404 while the list
  // — which renders the stored uppercase form — shows it as present.
  return String(code).toUpperCase();
}

export async function onRequestDelete({ request, env, params }) {
  try {
    await requireAdmin(env, request);
    const code = codeFrom(params);
    const client = createClient(env);

    const rows = await client.select('invite_codes',
      `select=id,code,status,used_count,last_used_by&code=eq.${encodeURIComponent(code)}&limit=1`);
    const invite = rows?.[0];
    if (!invite) throw new HttpError(404, 'CODE_NOT_FOUND', '邀请码不存在');

    // Revoking an exhausted or already-expired code still succeeds. It changes
    // nothing a learner could observe, and failing it would leave the operator
    // stuck with a button that reports an error for a row they can see needs
    // no further action.
    await client.update('invite_codes', `id=eq.${encodeURIComponent(invite.id)}`, {
      status: 'revoked',
      revoked_at: new Date().toISOString(),
    });

    return json({
      ok: true,
      code: invite.code,
      // The learner who used it, when there is one, so the confirm toast can
      // say whether anyone was already brought in by this code.
      redeemed_by: invite.last_used_by ?? null,
      used_count: Number(invite.used_count ?? 0),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
