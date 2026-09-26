/* Eastudy V3 — display formatting.

   Two of these carry real product rules from the legacy:
   `relativeTime` matches the EastudyRelativeTime contract exactly (刚刚 /
   N 分钟前 / N 小时前 / N 天前 / M 月 D 日 / YYYY 年 M 月 D 日), and
   `mergeRanges` is the same interval merge the watch-coverage statistic was
   built on, so stored history and displayed history cannot drift apart. */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function bytes(value, { decimals = 1 } = {}) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = n / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(size >= 100 ? 0 : decimals)} ${units[unit]}`;
}

/** Seconds -> 12:34 / 1:02:03 */
export function duration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function speed(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  if (value <= 0) return '—';
  return `${bytes(value)}/s`;
}

export function eta(remainingBytes, bytesPerSecond) {
  const rate = Number(bytesPerSecond) || 0;
  if (rate <= 0) return '预计时间计算中';
  const seconds = Math.max(0, Math.round(Number(remainingBytes) / rate));
  if (seconds < 60) return `约 ${seconds} 秒`;
  if (seconds < 3600) return `约 ${Math.round(seconds / 60)} 分钟`;
  return `约 ${(seconds / 3600).toFixed(1)} 小时`;
}

/** Beijing wall-clock day key, e.g. 2026-09-25. Used for streak/plan buckets
    so a learner studying at 00:30 CST is counted on the right day regardless
    of the device timezone. */
export function beijingDayKey(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  return new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function beijingParts(input = new Date()) {
  const shifted = new Date((input instanceof Date ? input : new Date(input)).getTime() + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function relativeTime(input, now = Date.now()) {
  if (!input) return '';
  const then = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (Number.isNaN(then)) return '';
  const diff = now - then;
  const minute = 60_000;

  if (diff < 0) return '刚刚';
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`;

  const a = beijingParts(new Date(then));
  const b = beijingParts(new Date(now));
  if (a.year === b.year) return `${a.month} 月 ${a.day} 日`;
  return `${a.year} 年 ${a.month} 月 ${a.day} 日`;
}

/** [{start,end}] -> merged, sorted, non-overlapping. */
export function mergeRanges(ranges) {
  const clean = (ranges || [])
    .map((range) => Array.isArray(range)
      ? { start: Number(range[0]), end: Number(range[1]) }
      : { start: Number(range.start), end: Number(range.end) })
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((x, y) => x.start - y.start);

  const merged = [];
  for (const range of clean) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Fraction of a video actually watched, 0..1, ignoring seeks forward. */
export function watchCoverage(ranges, durationSeconds) {
  const total = Number(durationSeconds) || 0;
  if (total <= 0) return 0;
  const watched = mergeRanges(ranges).reduce((sum, range) => sum + (range.end - range.start), 0);
  return Math.min(1, watched / total);
}

export function percent(value, { decimals = 0 } = {}) {
  const n = Number(value) || 0;
  return `${(n * 100).toFixed(decimals)}%`;
}

export function truncate(value, max = 40) {
  const str = String(value ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/** Deterministic hue from a stable id, for avatar chips without an image. */
export function hueFromId(id) {
  const str = String(id ?? '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 360;
  return hash;
}
