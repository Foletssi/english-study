/* /api/admin/learners/:id/vip — 开通 / 取消会员 (M09).

   GET  the learner as the membership dialog needs them
   POST grant or revoke, with an optional note for the audit log

   This was folded into the parent `[[path]].js` so that the learner lookup and
   the operator guard would exist once rather than twice. The reasoning was
   sound but the trade was unnecessary: the parent is now `[id].js` and exports
   `learnerId`, `loadLearner` and `project`, so this file reuses them by import
   instead of by sharing a pathname. Neither concern is duplicated, and the two
   routes no longer have to count path segments to tell each other apart.

   A catch-all could not stay: it matches zero segments, so it also answers
   `/api/admin/learners` and takes that list route away from ./index.js. The
   nesting here is what makes two depths possible without one — `/learners/:id`
   is the parent file, `/learners/:id/vip` is this one, and the deeper explicit
   route wins. Verified against `wrangler pages dev`.

   Everything below is gated on requireAdmin, as in the parent. A learner
   granting themselves membership is the failure mode this file exists to
   prevent, and the gate is the first statement of each handler rather than a
   middleware someone can forget to add. */

import { HttpError, errorResponse, json } from '../../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../../_lib/supabase.js';
import { pick, trimmed } from '../../../../_lib/fields.js';
import { learnerId, loadLearner, project } from '../[id].js';

/** GET — the parent detail route answers this path with the full activity
    payload, which is more than the dialog needs and more than it should be
    able to read. The dialog wants the profile it is about to change. */
export async function onRequestGet({ request, env, params }) {
  try {
    await requireAdmin(env, request);
    const id = learnerId(params);
    const client = createClient(env);
    return json({ learner: project(await loadLearner(client, id)) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPost({ request, env, params }) {
  try {
    // `user.id` is the authenticated operator, which is what the audit row
    // wants. Re-resolving it further down would mean a second round trip to the
    // auth server on every grant, for a value already in hand.
    const { user: operator } = await requireAdmin(env, request);
    const id = learnerId(params);

    const body = await request.json().catch(() => ({}));
    const client = createClient(env);
    // The learner is read first so a grant to a nonexistent id 404s instead of
    // silently writing nothing; the ownership filter cannot help here, because
    // an admin is *supposed* to touch someone else's row.
    const learner = await loadLearner(client, id);

    const enabled = pick(body, 'enabled');
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'ENABLED_REQUIRED', '缺少开通/取消标记');

    let expiresAt = null;
    if (enabled) {
      // The dialog computes the expiry client-side (now + N months) and sends an
      // ISO string. Falling back to the existing expiry would turn "开通" into a
      // no-op for a learner who already has time left, so when the caller does
      // not send one, a month is granted from whatever is later: the current
      // expiry or now. That is the same 顺延 rule the dialog promises in its
      // hint text.
      const requested = trimmed(pick(body, 'expires_at'), 40);
      if (requested && Number.isNaN(new Date(requested).getTime())) {
        throw new HttpError(400, 'EXPIRES_AT_INVALID', '到期时间格式不正确');
      }
      if (requested) {
        expiresAt = new Date(requested);
      } else {
        const current = learner.vip_expires_at ? new Date(learner.vip_expires_at).getTime() : 0;
        expiresAt = new Date(Math.max(current, Date.now()) + 30 * 24 * 60 * 60 * 1000);
      }
    }

    const note = trimmed(pick(body, 'note'), 200);
    const [updated] = await client.update('profiles', `id=eq.${encodeURIComponent(id)}`, {
      vip_expires_at: enabled ? expiresAt.toISOString() : null,
      updated_at: new Date().toISOString(),
    });

    // The note is kept in the audit log rather than on the profile: it describes
    // one grant, not the account, and overwriting a column on each grant would
    // lose the previous operator's reason. Logged best-effort — a missing log
    // table must not roll back a membership the operator just granted.
    await client.insert('admin_audit_log', {
      actor_id: operator.id,
      action: enabled ? 'vip.grant' : 'vip.revoke',
      target_type: 'profile',
      target_id: id,
      note,
      created_at: new Date().toISOString(),
    }).catch(() => {});

    return json({ learner: project(updated ?? { ...learner, vip_expires_at: enabled ? expiresAt.toISOString() : null }) });
  } catch (error) {
    return errorResponse(error);
  }
}
