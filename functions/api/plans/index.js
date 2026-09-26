/* /api/plans — 学习计划列表与新建 (M05).

   GET  the caller's plans, each with its ordered items
   POST create a plan

   Two things the client depends on that are easy to get wrong:

   - The response must carry `total`. `createListController` renders the pager
     from it, and a missing `total` reads as "共 0 条" next to a full list.
   - Each plan must carry `items` with `{ video_id, title, position }`, in plan
     order. The page computes "3 / 10 已完成" by intersecting `items` with the
     progress rows it already holds, so an item's `video_id` has to be the same
     id those rows key on. It reads `item.title` too, and shows
     "(视频已下架)" when the title is missing — so a removed video keeps its
     slot instead of shifting the rest of the plan up.

   Progress itself is deliberately not denormalised into this response. The
   completion rule lives in one place (coverage ≥ 90%, see progress.js), and a
   copy of the count here would be a second place for it to be wrong. */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { createClient, requireUser } from '../../_lib/supabase.js';
import { pick, trimmed } from '../../_lib/fields.js';
import { readPaging, readTotal, listResponse } from '../../_lib/paging.js';

const PLAN_ITEM_LIMIT = 200;

/** PostgREST caps a single response, and the client's own cap is 200 items per
    plan — so this is only a guard against a pathological `in.(...)` list. */
const TITLE_LOOKUP_LIMIT = 1000;

/** Attach ordered items to a page of plans in a fixed number of extra round
    trips rather than one per plan: the list is paged at 20, so the naive
    version is 20 queries per page render. */
async function attachItems(client, plans) {
  if (!plans.length) return plans.map((plan) => ({ ...plan, items: [] }));

  const ids = plans.map((plan) => encodeURIComponent(plan.id)).join(',');
  const rows = await client.select('plan_items',
    `select=plan_id,video_id,position&plan_id=in.(${ids})&order=position.asc&limit=${PLAN_ITEM_LIMIT * plans.length}`);

  const videoIds = [...new Set((rows ?? []).map((row) => row.video_id).filter(Boolean))];
  // Titles come from `videos` without a published filter: a plan referencing an
  // archived video should still show the slot, and the client decides how to
  // label it. `title` is null when the row is gone, which is what the page
  // renders as "(视频已下架)".
  const titles = new Map();
  if (videoIds.length) {
    const videos = await client.select('videos',
      `select=id,title&id=in.(${videoIds.map(encodeURIComponent).join(',')})&limit=${TITLE_LOOKUP_LIMIT}`);
    for (const video of videos ?? []) titles.set(video.id, video.title);
  }

  const byPlan = new Map();
  for (const row of rows ?? []) {
    if (!byPlan.has(row.plan_id)) byPlan.set(row.plan_id, []);
    byPlan.get(row.plan_id).push({
      video_id: row.video_id,
      title: titles.get(row.video_id) ?? null,
      position: row.position ?? 0,
    });
  }

  return plans.map((plan) => ({ ...plan, items: byPlan.get(plan.id) ?? [] }));
}

/** Replace a plan's items with `videoIds`, in the given order. Shared with the
    `[[path]]` sibling so PATCH and POST cannot disagree about what an item is. */
export async function writeItems(client, planId, videoIds) {
  const wanted = [...new Set((Array.isArray(videoIds) ? videoIds : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean))].slice(0, PLAN_ITEM_LIMIT);

  // Replace, not merge: the edit dialog sends the full ordered list, so a merge
  // would make "移除" a no-op.
  await client.remove('plan_items', `plan_id=eq.${encodeURIComponent(planId)}`);
  if (!wanted.length) return [];

  const rows = wanted.map((videoId, index) => ({
    plan_id: planId,
    video_id: videoId,
    position: index,
  }));
  await client.insert('plan_items', rows);

  const videos = await client.select('videos',
    `select=id,title&id=in.(${wanted.map(encodeURIComponent).join(',')})&limit=${TITLE_LOOKUP_LIMIT}`);
  const titles = new Map((videos ?? []).map((video) => [video.id, video.title]));
  return rows.map((row) => ({
    video_id: row.video_id,
    title: titles.get(row.video_id) ?? null,
    position: row.position,
  }));
}

export async function onRequestGet({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const { page, pageSize, offset } = readPaging(new URL(request.url), { defaultPageSize: 20 });
    const client = createClient(env);

    const query = `select=id,title,target_date,created_at,updated_at`
      + `&user_id=eq.${encodeURIComponent(user.id)}`
      + `&order=created_at.desc&limit=${pageSize}&offset=${offset}`;
    // listResponse reads the total out of Content-Range, so the count has to be
    // requested — setting `count=exact` and never reading the header is how the
    // legacy ended up with pagers that always said "共 0 条".
    const response = await client.call(`plans?${query}`, { headers: { Prefer: 'count=exact' } });
    const rows = Array.isArray(response) ? response : [];
    const total = readTotal(response, rows);

    return listResponse({ rows: await attachItems(client, rows), total, page, pageSize });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const body = await request.json().catch(() => ({}));
    const title = trimmed(pick(body, 'title'), 80);
    if (!title) throw new HttpError(400, 'TITLE_REQUIRED', '请填写计划名称');

    const client = createClient(env);
    const [plan] = await client.insert('plans', {
      user_id: user.id,
      title,
      target_date: trimmed(pick(body, 'target_date'), 10),
      created_at: new Date().toISOString(),
    });
    if (!plan) throw new HttpError(500, 'PLAN_CREATE_FAILED', '计划创建失败');

    // The create dialog only sends a title and a date. A caller that sends
    // `video_ids` up front is honoured so it needs only one round trip.
    const items = await writeItems(client, plan.id, pick(body, 'video_ids', []));
    return json({ plan: { ...plan, items } }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
