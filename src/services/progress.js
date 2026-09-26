/* Eastudy V3 — learning progress.

   The client only ever sends `positionSeconds` and `durationSeconds`; the
   server merges the ranges and decides completion. That split matters: a
   client that could post `completed: true` directly is a client that can be
   lied to, and the legacy let the browser compute completion from the furthest
   position reached, so dragging the scrubber to the end marked a video done. */

import { EVENTS, emit } from '../core/bus.js';

const REPORT_INTERVAL_MS = 15_000;

export function createProgressService({ api }) {
  const latest = new Map();       // videoId → row
  const pending = new Map();      // videoId → payload awaiting flush
  const timers = new Map();
  let flushTimer = null;

  function inflightGuard(fn) {
    let running = null;
    return (...args) => {
      if (running) return running;
      running = Promise.resolve(fn(...args)).finally(() => { running = null; });
      return running;
    };
  }

  async function fetchAll() {
    const result = await api.get('/api/progress');
    for (const row of result.rows ?? []) latest.set(row.video_id, row);
    emit(EVENTS.PROGRESS_CHANGED, { reason: 'fetch', rows: result.rows ?? [] });
    return result.rows ?? [];
  }

  /** Queue a heartbeat. Repeated calls inside the window collapse to one write. */
  function report({ videoId, positionSeconds, durationSeconds }) {
    if (!videoId || !Number.isFinite(positionSeconds)) return;
    pending.set(videoId, {
      video_id: videoId,
      position_seconds: positionSeconds,
      duration_seconds: durationSeconds,
    });
    if (timers.has(videoId)) return;
    timers.set(videoId, setTimeout(() => {
      timers.delete(videoId);
      flush(videoId).catch(() => {});
    }, REPORT_INTERVAL_MS));
  }

  async function flush(videoId = null) {
    const targets = videoId ? [videoId] : [...pending.keys()];
    if (!targets.length) return;
    const payloads = targets.map((id) => pending.get(id)).filter(Boolean);
    for (const id of targets) pending.delete(id);

    await Promise.all(payloads.map(async (payload) => {
      const result = await api.post('/api/progress', {
        video_id: payload.video_id,
        position_seconds: payload.position_seconds,
        duration_seconds: payload.duration_seconds,
      });
      if (result?.row) latest.set(result.row.video_id, result.row);
      emit(EVENTS.PROGRESS_CHANGED, { reason: 'write', row: result?.row, videoId: payload.video_id });
    }));
  }

  /** Called on pagehide / route change so a heartbeat in the debounce window is
      not lost when the learner closes the tab. */
  function flushNow({ keepalive = false } = {}) {
    const payloads = [...pending.values()];
    pending.clear();
    for (const payload of payloads) {
      const body = JSON.stringify({
        video_id: payload.video_id,
        position_seconds: payload.position_seconds,
        duration_seconds: payload.duration_seconds,
      });
      if (keepalive && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(api.urlFor?.('/api/progress') || '/api/progress', new Blob([body], { type: 'application/json' }));
      } else {
        api.post('/api/progress', JSON.parse(body)).catch(() => {});
      }
    }
  }

  /* 手动「标记已学」。走的是同一条 /api/progress, 写 learned_at 那一列 ——
     和 `completed` 无关, 后者只能由服务端从观看覆盖率算出来。

     先写本地再发请求, 因为播放器已经乐观点了灯: 只发请求不改本地缓存的话,
     界面是亮的、`get()` 却还说没标记, 同一个状态有两个说法。请求失败就把
     缓存回滚成请求前的值, 让读到的和看到的一起退回去。 */
  async function setLearned(videoId, learned) {
    if (!videoId) return null;
    const before = latest.get(videoId) ?? null;
    const at = learned ? new Date().toISOString() : null;
    latest.set(videoId, { ...(before ?? { video_id: videoId }), learned_at: at, video_id: videoId });

    try {
      const result = await api.post('/api/progress', { video_id: videoId, learned });
      if (result?.row) latest.set(result.row.video_id, result.row);
      emit(EVENTS.PROGRESS_CHANGED, { reason: 'learned', row: result?.row, videoId });
      return result?.row ?? null;
    } catch (error) {
      if (before) latest.set(videoId, before);
      else latest.delete(videoId);
      throw error;
    }
  }

  function isLearned(videoId) { return Boolean(latest.get(videoId)?.learned_at); }

  function get(videoId) { return latest.get(videoId) || null; }

  function resumePoint(videoId) {
    const row = latest.get(videoId);
    if (!row) return 0;
    // Do not resume in the last 10 seconds: it reads as "the video jumped to
    // the end" rather than "continue where you left off".
    if (row.completed) return 0;
    const duration = row.duration_seconds || 0;
    if (duration && row.position_seconds > duration - 10) return 0;
    return row.position_seconds || 0;
  }

  const flushAll = inflightGuard(() => flush(null));

  return {
    fetchAll, report, flush: flushAll, flushNow, get, resumePoint,
    setLearned, isLearned,
    get rows() { return [...latest.values()]; },
    stop() {
      if (flushTimer) clearTimeout(flushTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
