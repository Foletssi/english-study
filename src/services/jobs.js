/* Eastudy V3 — processing queue client (M08).

   The listing rule lives on the server: page over videos in PROCESSING/REVIEW
   first, then attach the newest job. That is what makes "one card = one video"
   true even when a video has been retried eleven times. The client keeps a
   light poll so the queue stays live without a websocket. */

import { EVENTS, emit } from '../core/bus.js';
import { jobBadge } from '../ui/status.js';

const POLL_INTERVAL_MS = 8000;

export function createJobsService({ api }) {
  let timer = null;
  let listeners = new Set();
  // `rows`, not `videos`: this service is the only list client that keeps a
  // copy of the response for `summary()`, and renaming the field here was how
  // the queue page ended up reading `result.videos` off an envelope that had
  // been standardised to `rows`.
  let last = { rows: [], counts: {} };
  let lastParams = {};

  async function list({ page = 1, pageSize = 20, state = '', stalled = false } = {}) {
    const result = await api.get('/api/admin/jobs', { query: { page, pageSize, state, stalled } });
    last = result;
    lastParams = { page: result.page ?? page, pageSize: result.pageSize ?? pageSize, state, stalled };
    emit(EVENTS.JOB_CHANGED, { reason: 'list', ...result });
    return result;
  }

  async function retry(jobId, { videoId } = {}) {
    const result = await api.post(`/api/admin/jobs/${encodeURIComponent(jobId)}`, { action: 'retry', video_id: videoId });
    emit(EVENTS.JOB_CHANGED, { reason: 'retry', jobId });
    return result;
  }

  async function cancel(jobId) {
    const result = await api.delete(`/api/admin/jobs/${encodeURIComponent(jobId)}`);
    emit(EVENTS.JOB_CHANGED, { reason: 'cancel', jobId });
    return result;
  }

  /** Poll only while the queue page is mounted, and stop when the tab is
      hidden — a background tab polling every 8s for hours is how the legacy
      burned its Supabase quota.

      The poll repeats the page's own filters and page number. It used to
      hardcode `page: 1` and no filters, so an operator reading page 3, or
      filtered to the stuck jobs, was dragged back to an unfiltered page 1
      every eight seconds. It reads `lastParams`, which `list()` records from
      the last request the page actually made. */
  function startPolling(onUpdate, { intervalMs = POLL_INTERVAL_MS } = {}) {
    stopPolling();
    const tick = async () => {
      if (document.hidden) return;
      try {
        const result = await list({ ...lastParams, pageSize: lastParams.pageSize ?? 20 });
        onUpdate?.(result);
      } catch { /* transient; the next tick retries */ }
    };
    timer = setInterval(tick, intervalMs);
    listeners.add(onUpdate);
    return stopPolling;
  }

  function stopPolling() {
    if (timer) { clearInterval(timer); timer = null; }
    listeners.clear();
  }

  const summary = () => ({
    waiting: last.counts?.WAITING ?? 0,
    running: last.counts?.RUNNING ?? 0,
    failed: last.counts?.FAILED ?? 0,
    stalled: (last.rows ?? []).filter((row) => row.stalled).length,
  });

  return { list, retry, cancel, startPolling, stopPolling, summary, badgeFor: jobBadge, get last() { return last; } };
}
