/* /api/plans/:id — 编辑与删除一个学习计划 (M05).

   PATCH  rename, re-date, and/or replace the video list
   DELETE remove the plan (the learner's watch progress is untouched)

   Every statement here is filtered by `user_id=eq.<caller>` in addition to the
   plan id. RLS is the second line of defence, not the first: a handler that
   looked a plan up by id alone would hand any signed-in learner the ability to
   rewrite or delete someone else's plan the moment a policy was loosened, and
   the failure would be silent — PATCH returns the row it wrote, so the attacker
   would see a perfectly normal 200. */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { createClient, requireUser } from '../../_lib/supabase.js';
import { pick, trimmed } from '../../_lib/fields.js';
import { writeItems } from './index.js';

const PLAN_COLUMNS = 'id,title,target_date,created_at,updated_at';

function planIdFrom(params) {
  // `/api/plans/<id>` → `params.id`, from the `[id].js` filename. This used to
  // slice the pathname and take the segment after `plans`, which is why the
  // file had to be a `[[path]].js` — and why `/api/plans` (the list route in
  // ./index.js) never reached its handler: a catch-all absorbs zero segments
  // too. The explicit parameter cannot be confused with the parent path.
  const id = params?.id;
  if (!id) throw new HttpError(400, 'PLAN_ID_REQUIRED', '缺少计划 ID');
  return Array.isArray(id) ? id[0] : id;
}

export async function onRequestPatch({ request, env, params }) {
  try {
    const { user } = await requireUser(env, request);
    const planId = planIdFrom(params);
    const body = await request.json().catch(() => ({}));
    const client = createClient(env);
    const scope = `id=eq.${encodeURIComponent(planId)}&user_id=eq.${encodeURIComponent(user.id)}`;

    const existing = await client.select('plans', `select=${PLAN_COLUMNS}&${scope}&limit=1`);
    // 404 rather than 403 for someone else's plan: a 403 confirms the id exists,
    // which turns this route into an oracle for enumerating other learners' ids.
    if (!existing?.[0]) throw new HttpError(404, 'PLAN_NOT_FOUND', '学习计划不存在');

    const patch = { updated_at: new Date().toISOString() };
    if (pick(body, 'title') !== undefined) {
      const title = trimmed(pick(body, 'title'), 80);
      if (!title) throw new HttpError(400, 'TITLE_REQUIRED', '请填写计划名称');
      patch.title = title;
    }
    if (pick(body, 'target_date') !== undefined) {
      // An empty string from the date input means "clear it", and PostgREST
      // needs an explicit null for that — `undefined` would be dropped and the
      // old date would silently survive.
      patch.target_date = trimmed(pick(body, 'target_date'), 10);
    }

    const [plan] = await client.update('plans', scope, patch);
    if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', '学习计划不存在');

    // `video_ids` absent means "leave the list alone"; an empty array means
    // "remove every video". The distinction is why this checks presence rather
    // than truthiness.
    const items = pick(body, 'video_ids') === undefined
      ? (await client.select('plan_items',
          `select=video_id,position&plan_id=eq.${encodeURIComponent(planId)}&order=position.asc`)) ?? []
      : await writeItems(client, planId, pick(body, 'video_ids'));

    return json({ plan: { ...plan, items } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestDelete({ request, env, params }) {
  try {
    const { user } = await requireUser(env, request);
    const planId = planIdFrom(params);
    const client = createClient(env);
    const scope = `id=eq.${encodeURIComponent(planId)}&user_id=eq.${encodeURIComponent(user.id)}`;

    const existing = await client.select('plans', `select=id&${scope}&limit=1`);
    if (!existing?.[0]) throw new HttpError(404, 'PLAN_NOT_FOUND', '学习计划不存在');

    // Items first: if `plan_items` has no ON DELETE CASCADE, deleting the plan
    // would leave orphans that reappear as phantom entries in the next plan
    // that happens to reuse the id.
    await client.remove('plan_items', `plan_id=eq.${encodeURIComponent(planId)}`);
    await client.remove('plans', scope);

    return json({ ok: true, id: planId });
  } catch (error) {
    return errorResponse(error);
  }
}
