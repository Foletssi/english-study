/* GET /api/admin/jobs — 处理队列,按视频聚合。

   The legacy M08 rule is explicit and was a real bug fix: filter to valid
   videos first, page over *videos*, and only then return that page's jobs, so
   one learner-facing card corresponds to exactly one video. Returning raw jobs
   produced several cards for one video whenever a retry or a re-run existed.

   This endpoint implements that rule: it pages over videos in a processing
   state, then attaches the latest job per video.

   Two things beyond the rows the queue page needs, both of which used to be
   missing here rather than in the page:

   - `total`, so the pager renders. Without it `createListController` computes
     `total: result.total ?? 0`, and `0 > pageSize` is false — the pager on the
     queue page could not appear no matter how many videos were waiting.

   - `counts`, the summary bar's three numbers. The client has always read
     `counts.WAITING / RUNNING / FAILED`; nothing ever sent it, so the queue
     summarised itself as three zeroes above a list of stuck jobs. It is
     computed with exact-count queries rather than by counting the loaded page:
     a per-page tally would report "排队中 12" on page 1 and a different number
     on page 2, for one unchanging queue. */

import { errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';
import { listResponse, readPaging, readTotal } from '../../../_lib/paging.js';

const PROCESSING_STATES = ['PROCESSING', 'REVIEW'];
const SUMMARY_STATES = ['WAITING', 'RUNNING', 'FAILED'];

const VIDEO_COLUMNS = 'id,title,status,pipeline_status,cover_url,created_at,updated_at,revision,job_id,duration_seconds';
const JOB_COLUMNS = 'id,video_id,state,stage,progress,lease_until,next_run_at,automatic_recovery_count,attempt,error_code,error_message,updated_at,created_at';

/** One count per state, in parallel. `limit=0` with `count=exact` fetches no
    rows at all — PostgREST reports the total in Content-Range and the body is
    empty — so three numbers cost three header-only queries. */
async function loadCounts(client) {
  const responses = await Promise.all(SUMMARY_STATES.map((state) => client
    .call(`processing_jobs?select=id&state=eq.${state}&limit=0`, { headers: { Prefer: 'count=exact' } })
    .catch(() => null)));

  const counts = {};
  SUMMARY_STATES.forEach((state, index) => {
    const response = responses[index];
    counts[state] = response ? readTotal(response, []) : 0;
  });
  return counts;
}

function isStalled(job) {
  return Boolean(job?.lease_until
    && new Date(job.lease_until).getTime() < Date.now()
    && job.state === 'RUNNING');
}

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const url = new URL(request.url);
    const { page, pageSize, offset } = readPaging(url, { defaultPageSize: 20, maxPageSize: 60 });
    const pipeline = url.searchParams.get('pipeline');
    const onlyStalled = url.searchParams.get('stalled') === 'true';

    const filters = [
      `select=${VIDEO_COLUMNS}`,
      `status=in.(${PROCESSING_STATES.join(',')})`,
      'order=updated_at.desc',
      `limit=${pageSize}`,
      `offset=${offset}`,
    ];
    if (pipeline) filters.push(`pipeline_status=eq.${encodeURIComponent(pipeline)}`);

    const client = createClient(env);
    const response = await client.call(`videos?${filters.join('&')}`, {
      headers: { Prefer: 'count=exact' },
    });
    const videos = Array.isArray(response) ? response : [];
    const total = readTotal(response, videos);

    // The counts are independent of the page, so they are fetched alongside the
    // rows rather than after them — the summary bar should not arrive late on a
    // slow queue.
    const countsPromise = loadCounts(client);

    let rows = [];
    if (videos.length) {
      // One job per video: the newest. Everything else is history the UI can
      // expand on demand, which keeps the list honest ("这张卡就是一个视频").
      const ids = videos.map((video) => encodeURIComponent(video.id)).join(',');
      const jobs = await client.select('processing_jobs',
        `select=${JOB_COLUMNS}&video_id=in.(${ids})&order=created_at.desc`).catch(() => []);

      const latest = new Map();
      for (const job of jobs ?? []) {
        if (!latest.has(job.video_id)) latest.set(job.video_id, job);
      }

      rows = videos.map((video) => {
        const job = latest.get(video.id) ?? null;
        return {
          video,
          job,
          // Stalled means the lease lapsed and nothing is running: the UI shows
          // a recover button rather than an indefinite spinner.
          stalled: isStalled(job),
        };
      });
    }

    // Applied after the page is sliced, which is the one thing here that cannot
    // be pushed into PostgREST: whether a lease has lapsed is a comparison
    // against now, and `lease_until` is null for anything not currently leased.
    // The cost is that a filtered page can come back short while `total` stays
    // the unfiltered count, so the pager still walks the full queue.
    if (onlyStalled) rows = rows.filter((row) => row.stalled);

    return listResponse({ rows, total, page, pageSize, extra: { counts: await countsPromise } });
  } catch (error) {
    return errorResponse(error);
  }
}
