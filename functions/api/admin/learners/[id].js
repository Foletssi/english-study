/* GET /api/admin/learners/:id — 学员详情 (M09).

   Profile plus the activity numbers the detail view shows. The membership
   action lives next door in `[id]/vip.js`; both depths are gated on
   requireAdmin, and the learner lookup is exported here so that route reuses
   this one rather than growing a second copy that drifts.

   Why this file is `[id].js` and not `[[path]].js`: a catch-all absorbs ZERO
   segments as well as many, so it also answers `/api/admin/learners` — the list
   route in ./index.js — which is how that endpoint was silently replaced by
   this file's detail handler. `[id].js` matches exactly one segment and cannot
   rival its parent. Verified against `wrangler pages dev`; guarded by
   tests/unit/syntax.test.mjs.

   A learner reading another learner's phone number is the failure mode this
   whole file exists to prevent, and it is worth stating that the gate is the
   first statement of every handler rather than a middleware someone can forget
   to add. */

import { HttpError, errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';

export const LEARNER_COLUMNS = 'id,display_name,phone,role,vip_expires_at,invited_by_code,created_at';

/** PostgREST caps a single response; the progress query below asks for at most
    200 rows, so this only guards a pathological `in.(...)` list. Same bound and
    same reason as plans/index.js. */
const TITLE_LOOKUP_LIMIT = 1000;

/** The `:id` this route is addressed by. `params.id` for a `[id].js` file; the
    array form is kept because a nested `[id]/vip.js` may hand back the segment
    as a one-element list, and both depths share this reader. */
export function learnerId(params) {
  const raw = params?.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id) throw new HttpError(400, 'LEARNER_ID_REQUIRED', '缺少学员 ID');
  return id;
}

export async function loadLearner(client, id) {
  const rows = await client.select('profiles', `select=${LEARNER_COLUMNS}&id=eq.${encodeURIComponent(id)}&limit=1`);
  const learner = rows?.[0];
  if (!learner) throw new HttpError(404, 'LEARNER_NOT_FOUND', '学员不存在');
  return learner;
}

/** A learner's own activity, for the detail view. Each of these is best-effort:
    the detail page is still worth rendering when one of the queries fails, and
    a hard 500 on the whole page because an auxiliary table is missing would
    hide the profile the operator actually came to look at. */
export async function loadActivity(client, id) {
  const scope = `user_id=eq.${encodeURIComponent(id)}`;
  const [progress, words, plans] = await Promise.all([
    client.select('learning_progress', `select=video_id,coverage,completed,updated_at&${scope}&order=updated_at.desc&limit=200`).catch(() => []),
    client.select('vocabulary_words', `select=id,term,kind&${scope}&limit=500`).catch(() => []),
    client.select('plans', `select=id,title,target_date&${scope}&limit=100`).catch(() => []),
  ]);

  const rows = progress ?? [];
  return {
    // Computed from the same rows the student's own account page reads, and by
    // the same rule — `completed` is the server's verdict, never re-derived
    // from `coverage` here. A second threshold in this file is how the two
    // surfaces start reporting different completion counts for one learner.
    completed_count: rows.filter((row) => row.completed).length,
    learning_count: rows.filter((row) => !row.completed && (row.coverage || 0) > 0.02).length,
    progress_rows: await withTitles(client, rows),
    vocabulary_count: (words ?? []).filter((word) => word.kind === 'saved').length,
    following_count: (words ?? []).filter((word) => word.kind === 'followed').length,
    plans: plans ?? [],
  };
}

/** Attach a title to each progress row, in one extra query for the whole set.

    Resolved here rather than on the page for two reasons. The page cannot ask
    for the titles without first knowing which ids it needs — and the video list
    it would ask is a paged endpoint, so "fetch 200 to cover every id" silently
    returns one page and leaves the rest of the table showing raw uuids. And
    the lookup must never be able to fail the page: a title is a nicety, while
    the rows are the answer to "why is this learner stuck". A failed lookup
    leaves `title: null` and the page falls back to the id. */
async function withTitles(client, rows) {
  if (!rows.length) return rows;
  const videoIds = [...new Set(rows.map((row) => row.video_id).filter(Boolean))];
  if (!videoIds.length) return rows;

  // Titles come from `videos` without a published filter: a learner who watched
  // something since taken down should still see the row, labelled with whatever
  // the operator knows it as.
  const videos = await client.select('videos',
    `select=id,title&id=in.(${videoIds.map(encodeURIComponent).join(',')})&limit=${TITLE_LOOKUP_LIMIT}`)
    .catch(() => []);
  const titles = new Map((videos ?? []).map((video) => [video.id, video.title]));

  return rows.map((row) => ({ ...row, title: titles.get(row.video_id) ?? null }));
}

/** The shape both routes return for a learner, so the detail view and the
    membership dialog cannot disagree about whether someone is a VIP.

    Deliberately a separate expression from the one in ./index.js rather than a
    shared import: the list page renders from its own copy, and a table that
    starts showing a field the dialog does not is a real regression. Note what
    does NOT guard that — the contract test checks which paths exist, never
    response shapes — so the pairing is held by the two expressions happening to
    agree, and any edit to one is a deliberate edit to the contract. */
export function project(row) {
  const expiry = row.vip_expires_at ? new Date(row.vip_expires_at).getTime() : 0;
  return {
    id: row.id,
    display_name: row.display_name ?? null,
    phone: row.phone ?? null,
    role: row.role ?? 'learner',
    vip_expires_at: row.vip_expires_at ?? null,
    is_vip: Boolean(expiry && expiry > Date.now()),
    invite_code: row.invited_by_code ?? null,
    created_at: row.created_at ?? null,
  };
}

export async function onRequestGet({ request, env, params }) {
  try {
    await requireAdmin(env, request);
    const id = learnerId(params);
    const client = createClient(env);
    const learner = await loadLearner(client, id);

    return json({ learner: project(learner), activity: await loadActivity(client, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
