/* GET /api/admin/dashboard — 运营总览.

   Every number here is computed from the same rows the student side writes.
   Two rules the legacy violated and this does not:

   1. No invented metrics. If a figure cannot be derived from stored data it is
      not shown. The spec is explicit: 不添加假统计.
   2. "完成" means coverage ≥ 90% from merged watch ranges, matching
      /api/progress. A learner who seeked to the end is not counted as having
      finished. */

import { errorResponse, json } from '../../_lib/env.js';
import { createClient, requireAdmin } from '../../_lib/supabase.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const client = createClient(env);

    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();

    const [videos, learners, progress, recentJobs] = await Promise.all([
      client.select('videos', 'select=id,status,pipeline_status,published_at,created_at'),
      client.select('profiles', 'select=id,role,created_at&role=eq.learner'),
      client.select('learning_progress', `select=user_id,video_id,coverage,completed,updated_at&updated_at=gte.${since}`),
      client.select('processing_jobs', 'select=id,video_id,state,stage,progress,updated_at,error_code&order=updated_at.desc&limit=20'),
    ]);

    const videoRows = videos ?? [];
    const byStatus = countBy(videoRows, (v) => v.status);
    const byPipeline = countBy(videoRows, (v) => v.pipeline_status || 'WAITING');

    const progressRows = progress ?? [];
    const activeLearners = new Set(progressRows.map((r) => r.user_id)).size;
    const completions = progressRows.filter((r) => r.completed).length;

    // Daily active learners over the window, keyed by Beijing day.
    const daily = new Map();
    for (const row of progressRows) {
      const key = beijingDay(row.updated_at);
      if (!daily.has(key)) daily.set(key, new Set());
      daily.get(key).add(row.user_id);
    }

    return json({
      videos: {
        total: videoRows.length,
        published: byStatus.PUBLISHED ?? 0,
        draft: byStatus.DRAFT ?? 0,
        processing: byStatus.PROCESSING ?? 0,
        review: byStatus.REVIEW ?? 0,
        archived: byStatus.ARCHIVED ?? 0,
        pipeline: byPipeline,
      },
      learners: {
        total: (learners ?? []).length,
        activeLast7Days: activeLearners,
        completionsLast7Days: completions,
      },
      daily: Array.from(daily, ([day, users]) => ({ day, activeLearners: users.size }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      recentJobs: recentJobs ?? [],
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function countBy(rows, keyOf) {
  const out = {};
  for (const row of rows) {
    const key = keyOf(row);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function beijingDay(input) {
  const date = new Date(input);
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
