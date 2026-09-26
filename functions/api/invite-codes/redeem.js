/* /api/invite-codes/redeem — 兑换邀请码 (M01).

   POST { code } → 开通或延长会员.

   Three checks, and each one of them is a check the legacy skipped:

   - The code is read inside a single UPDATE ... WHERE, not read-then-written.
     Reading `used_count`, deciding it is under `max_uses`, and then writing
     the new count is a race: two learners submitting the same single-use code
     a second apart both read 0 and both get membership. The conditional update
     is what makes `max_uses` mean anything.
   - An expired code is refused. `expires_at` was stored by the admin UI from
     the first commit but never consulted at redemption, so a code from a
     campaign that ended in January still worked in June.
   - A revoked code is refused. Revoking set a status the redeem path ignored.

   Membership is *extended*, not reset: a learner who already has 20 days left
   and redeems a 30-day code ends up with 50, not 30. Resetting would quietly
   take away time they already had, which is the kind of bug a learner notices
   only after it has cost them.

   The code is uppercased here because the account page uppercases what the
   learner types (`field.value.trim().toUpperCase()`) — so a code pasted in
   lowercase, or typed from a printed card, still resolves. */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { createClient, requireUser } from '../../_lib/supabase.js';
import { pick, trimmed } from '../../_lib/fields.js';

/** How long a redemption grants, when the invite code itself does not say.
    A code may carry `vip_days`; this is the fallback so an older row created
    before that column existed still grants something sensible. */
const DEFAULT_VIP_DAYS = 30;

export async function onRequestPost({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const body = await request.json().catch(() => ({}));

    const code = trimmed(pick(body, 'code'), 64)?.toUpperCase();
    if (!code) throw new HttpError(400, 'CODE_REQUIRED', '请输入邀请码');

    const client = createClient(env);
    const now = new Date();

    const rows = await client.select('invite_codes',
      `select=id,code,status,used_count,max_uses,expires_at,vip_days,note&code=eq.${encodeURIComponent(code)}&limit=1`);
    const invite = rows?.[0];

    // One error for "no such code", "expired" and "revoked" where the learner
    // is concerned — but the codes differ, because the account page shows the
    // message and an operator reading a support ticket needs to know which.
    if (!invite) throw new HttpError(404, 'CODE_NOT_FOUND', '邀请码无效');
    if (invite.status && invite.status !== 'active') {
      throw new HttpError(409, 'CODE_REVOKED', '该邀请码已被停用');
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < now.getTime()) {
      throw new HttpError(409, 'CODE_EXPIRED', '该邀请码已过期');
    }

    const maxUses = Number(invite.max_uses ?? 1);
    const usedCount = Number(invite.used_count ?? 0);
    if (usedCount >= maxUses) throw new HttpError(409, 'CODE_EXHAUSTED', '该邀请码已被使用完');

    // Claim the code with a conditional update. The `used_count=eq.<n>` filter
    // is the lock: if another redemption incremented it between the read above
    // and this write, no row matches and the update returns empty, which is how
    // this request learns it lost the race instead of handing out a second
    // membership from a one-use code.
    const claimed = await client.update(
      'invite_codes',
      `id=eq.${encodeURIComponent(invite.id)}&used_count=eq.${usedCount}`,
      {
        used_count: usedCount + 1,
        last_used_at: now.toISOString(),
        last_used_by: user.id,
      },
    );
    if (!claimed?.length) throw new HttpError(409, 'CODE_TAKEN', '邀请码刚刚被使用,请换一个');

    const current = await client.select('profiles',
      `select=id,vip_expires_at,invited_by_code&id=eq.${encodeURIComponent(user.id)}&limit=1`);
    const profile = current?.[0];
    if (!profile) throw new HttpError(404, 'PROFILE_NOT_FOUND', '账号资料不存在');

    const days = Number(invite.vip_days) > 0 ? Number(invite.vip_days) : DEFAULT_VIP_DAYS;
    const existingExpiry = profile.vip_expires_at ? new Date(profile.vip_expires_at).getTime() : 0;
    // Extend from whichever is later: the current expiry, or now. A learner
    // whose membership lapsed last week gets a full `days` from today, not a
    // grant that is partly in the past.
    const base = Math.max(existingExpiry, now.getTime());
    const expiresAt = new Date(base + days * 24 * 60 * 60 * 1000);

    const [updated] = await client.update('profiles',
      `id=eq.${encodeURIComponent(user.id)}`,
      {
        vip_expires_at: expiresAt.toISOString(),
        // Recorded only on the first redemption: this column answers "who
        // brought this learner in", and overwriting it would reassign the
        // referral to whoever sent the most recent gift code.
        ...(profile.invited_by_code ? {} : { invited_by_code: code }),
        updated_at: now.toISOString(),
      });

    return json({
      profile: updated ?? null,
      vip_expires_at: expiresAt.toISOString(),
      granted_days: days,
      message: `兑换成功,会员有效期至 ${expiresAt.toISOString().slice(0, 10)}`,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
