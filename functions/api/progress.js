/* /api/progress — 学习进度。

   GET  the signed-in learner's progress rows
   POST upsert one progress record

   The student↔admin mapping matters most here: the admin dashboard's "学习
  人数/完成率" numbers are computed from exactly the rows this endpoint writes,
   so the two surfaces cannot disagree about what a completion means. The
   definition is fixed: a video counts as complete when watched coverage
   reaches 90%, and coverage is computed from merged watch ranges, never from
   the furthest playback position (seeking to the end must not fake a finish). */

import { HttpError, errorResponse, json } from '../_lib/env.js';
import { createClient, requireUser } from '../_lib/supabase.js';
import { pick } from '../_lib/fields.js';

const COMPLETION_THRESHOLD = 0.9;

function mergeRanges(ranges) {
  const clean = (ranges || [])
    .map((r) => ({ start: Number(r.start), end: Number(r.end) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of clean) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function coverage(ranges, durationSeconds) {
  const total = Number(durationSeconds) || 0;
  if (total <= 0) return 0;
  const watched = mergeRanges(ranges).reduce((sum, r) => sum + (r.end - r.start), 0);
  return Math.min(1, watched / total);
}

export async function onRequestGet({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const url = new URL(request.url);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const client = createClient(env);
    const rows = await client.select(
      'learning_progress',
      `select=video_id,position_seconds,watch_ranges,coverage,completed,completed_at,learned_at,updated_at&user_id=eq.${encodeURIComponent(user.id)}&order=updated_at.desc&limit=${limit}`,
    );
    return json({ rows: rows ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const body = await request.json();
    // The client sends `video_id`; the first draft read `videoId`, which made
    // every heartbeat 400. Both spellings are accepted now.
    const videoId = pick(body, 'video_id');
    if (!videoId) throw new HttpError(400, 'VIDEO_ID_REQUIRED', '缺少视频 ID');

    const client = createClient(env);
    const videoRows = await client.select('videos',
      `select=id,duration_seconds,status&id=eq.${encodeURIComponent(videoId)}&limit=1`);
    const video = videoRows?.[0];
    if (!video) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在');
    if (video.status !== 'PUBLISHED') throw new HttpError(403, 'NOT_PUBLISHED', '该视频尚未发布');

    /* 「标记已学」与心跳共用这一个端点, 因为两者写的是同一行的不同列, 拆成
       两个路由会出现"先标记后心跳"和"先心跳后标记"两种到达顺序, upsert 反而
       更容易互相覆盖。区分靠这里: 显式带了这个字段才是标记操作。

       它**只**动 learned_at。不能顺手把 completed 一起置真 —— 那一列是服务端
       从覆盖率算出来的, 学员按一下按钮就能写, 等于把防作弊的设计拆了。 */
    const learned = pick(body, 'learned', null);
    const isLearnedToggle = learned !== null && learned !== undefined;

    // 纯标记请求不带位置。若照常走下面的 `?? 0`, 一次标记就把已看进度清零、
    // watch_ranges 也被覆盖成空 —— 标记一下反而丢了进度。
    const position = isLearnedToggle
      ? (Number(prior?.position_seconds) || 0)
      : Math.max(0, Number(pick(body, 'position_seconds', 0)) || 0);
    const clientDuration = Number(pick(body, 'duration_seconds', 0)) || 0;
    const duration = Number(video.duration_seconds) || clientDuration;

    // `completed_at` is in the select because the upsert below preserves it.
    // It used to be absent, so `prior.completed_at` was always undefined and the
    // `?? null` wrote NULL over the completion timestamp on every heartbeat —
    // a learner who finished a video and kept watching lost the date they
    // finished it, and the admin's "completed this week" count quietly went to
    // zero. A column that is read must be selected.
    const previous = await client.select('learning_progress',
      `select=watch_ranges,coverage,position_seconds,completed,completed_at&user_id=eq.${encodeURIComponent(user.id)}&video_id=eq.${encodeURIComponent(videoId)}&limit=1`);
    const prior = previous?.[0];
    const wasCompleted = Boolean(prior?.completed);

    // The client sends only a position and a duration; the server turns the
    // sequence of positions into watched ranges. An explicit `watch_ranges`
    // array is honoured when present, so a client that keeps its own ledger
    // can send the richer form — and the ranges are unioned with what is
    // already stored, never replaced, so coverage only ever grows.
    const reported = Array.isArray(pick(body, 'watch_ranges', null));
    const ranges = reported
      ? pick(body, 'watch_ranges')
      : [...(prior?.watch_ranges ?? []), { start: Math.max(0, position - 5), end: position }];

    const merged = mergeRanges(ranges);
    const ratio = coverage(merged, duration);
    const best = Math.max(ratio, Number(prior?.coverage) || 0);
    const completed = wasCompleted || best >= COMPLETION_THRESHOLD;

    /* 标记的到达顺序会乱: 学员可能在心搏的防抖窗口里点这一键, 于是标记先落库、
       心跳随后覆盖。所以这里不是"写一个值", 而是和 completed_at 同一套写法 ——
       已经标过的保留原时间(不能因为再点一次就刷新成今天), 只有从未标过才落新
       时间戳。取消标记则显式置 NULL。 */
    const learnedAt = isLearnedToggle
      ? (learned ? (prior?.learned_at ?? new Date().toISOString()) : null)
      : (prior?.learned_at ?? null);

    const [row] = await client.upsert('learning_progress', {
      user_id: user.id,
      video_id: videoId,
      position_seconds: position,
      watch_ranges: merged,
      coverage: best,
      completed,
      completed_at: wasCompleted ? (prior.completed_at ?? null) : (completed ? new Date().toISOString() : null),
      learned_at: learnedAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,video_id' });

    // The client keys its cache off `row.video_id`, so the envelope is part of
    // the contract, not a naming preference.
    return json({ row, coverage: best });
  } catch (error) {
    return errorResponse(error);
  }
}
