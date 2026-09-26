/* GET /api/admin/settings/worker — 处理服务心跳 (M10).

   Answers one question for the dashboard: is the machine that does the heavy
   lifting (download, transcode, subtitle, upload) still alive, and what is it
   doing. The health card reads `ok` and `detail` — nothing else is required by
   the client, so everything beyond those two keys is for the operator reading
   the panel, not for the page to branch on.

   The freshness window is the whole point. The legacy's health card was a
   hard-coded green dot and showed 正常 for days after the worker died, so the
   dashboard reported a healthy system while nothing was being processed. Here
   `ok` is derived from *when the worker last wrote*, never from whether the row
   exists: a worker that registered once and then crashed leaves a row behind,
   and a check that asks "is there a heartbeat" answers yes forever.

   Nothing writes that heartbeat from the edge. It is written by the worker
   itself, from the operator's machine, against the same table — which is what
   makes the timestamp evidence rather than a self-report. */

import { errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';

/** How old a heartbeat may be before the worker counts as down. The worker
    beats every 30 seconds; two minutes of silence is four missed beats, which
    is long enough to survive a GC pause or a brief network fault and short
    enough that the card turns red while the operator is still looking at it. */
const STALE_AFTER_MS = 120_000;

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const client = createClient(env);

    const rows = await client.select('worker_heartbeats',
      'select=worker_id,status,current_job_id,started_at,last_seen_at,version,detail&order=last_seen_at.desc&limit=20'
    ).catch(() => null);

    // A missing table is reported as down rather than as a 500. The dashboard
    // asks three services in parallel (`system.overview`), and one failure must
    // not take the other two cards with it — the page renders what it has.
    if (rows === null) {
      return json({
        ok: false,
        detail: '心跳表不可用,请确认已执行迁移',
        workers: [],
        checked_at: new Date().toISOString(),
      });
    }

    const now = Date.now();
    const workers = (rows ?? []).map((row) => {
      const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
      const ageMs = lastSeen ? now - lastSeen : Number.POSITIVE_INFINITY;
      return {
        worker_id: row.worker_id ?? null,
        status: row.status ?? 'unknown',
        current_job_id: row.current_job_id ?? null,
        started_at: row.started_at ?? null,
        last_seen_at: row.last_seen_at ?? null,
        age_seconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
        version: row.version ?? null,
        detail: row.detail ?? null,
        // Per-worker, so the panel can show "one of three is stale" instead of
        // collapsing several machines into a single up/down bit.
        alive: ageMs <= STALE_AFTER_MS,
      };
    });

    const alive = workers.filter((worker) => worker.alive);
    const newest = workers[0] ?? null;

    return json({
      // `ok` means "something that can process jobs is currently reachable" —
      // not "a worker was configured". With several workers, one dead machine
      // must not read as a broken system, and with none the answer is no.
      ok: alive.length > 0,
      detail: alive.length
        ? `${alive.length} 个处理服务在线`
        : (newest
            ? `处理服务已停止响应(最后心跳 ${newest.age_seconds ?? '?'} 秒前)`
            : '没有处理服务在运行'),
      workers,
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
