/* Eastudy V3 — chunk sizing and the concurrency governor.

   The legacy took the chunk size from the server (`status.chunkBytes`) and
   never reconsidered it; a 2 GB file over a fast link was therefore stuck at
   whatever the first handshake happened to pick. V3 plans a size from the file
   itself, lets the server tighten it, and adapts concurrency to the link as it
   runs. */

export const CHUNK_MIN = 8 * 1024 * 1024;
export const CHUNK_MAX = 64 * 1024 * 1024;
export const CHUNK_ALIGN = 1024 * 1024;
export const MAX_CHUNKS = 512;

function clampToRange(size) {
  return Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.round(size / CHUNK_ALIGN) * CHUNK_ALIGN || CHUNK_MIN));
}

/**
 * Pick a chunk size for a file.
 * Larger chunks amortise per-request overhead but cost more on retry, so the
 * ladder trades off: small files get small chunks, and the count is capped so
 * a very large file does not produce thousands of round trips.
 */
export function planChunks(fileSize, { min = CHUNK_MIN, max = CHUNK_MAX, maxChunks = MAX_CHUNKS } = {}) {
  const size = Number(fileSize) || 0;
  if (size <= 0) return { chunkSize: clampToRange(min), count: 0 };

  let chunkSize;
  if (size <= 64 * 1024 * 1024) chunkSize = min;
  else if (size <= 256 * 1024 * 1024) chunkSize = 16 * 1024 * 1024;
  else if (size <= 512 * 1024 * 1024) chunkSize = 32 * 1024 * 1024;
  else chunkSize = 48 * 1024 * 1024;

  chunkSize = clampToRange(chunkSize);

  // Grow until the chunk count fits the cap.
  while (Math.ceil(size / chunkSize) > maxChunks && chunkSize < max) {
    chunkSize = clampToRange(chunkSize * 2);
  }
  // Shrink back when a tiny file would otherwise leave most of a chunk unused.
  if (size < chunkSize) chunkSize = clampToRange(Math.max(min, size));

  return { chunkSize, count: Math.ceil(size / chunkSize) };
}

/**
 * AIMD concurrency control: additive increase, multiplicative decrease.
 * Grows by one after a run of clean chunks, at most once per second, and
 * halves on any failure. This is what keeps a slow or lossy link from being
 * buried under parallel requests while still saturating a fast one.
 */
export class ConcurrencyGovernor {
  constructor({ initial = 4, min = 1, max = 8, growAfter = 3, growIntervalMs = 1000 } = {}) {
    this.min = Math.max(1, min);
    this.max = Math.max(this.min, max);
    this.growAfter = Math.max(1, growAfter);
    this.growIntervalMs = growIntervalMs;
    this.value = Math.max(this.min, Math.min(this.max, initial));
    this.cleanRun = 0;
    this.lastGrowAt = 0;
  }

  /** @returns {number|null} the new value when it grew, otherwise null. */
  onSuccess() {
    this.cleanRun++;
    if (this.cleanRun < this.growAfter || this.value >= this.max) return null;
    const now = Date.now();
    if (now - this.lastGrowAt < this.growIntervalMs) return null;
    this.cleanRun = 0;
    this.lastGrowAt = now;
    this.value = Math.min(this.max, this.value + 1);
    return this.value;
  }

  /** @returns {number|null} the new value when it shrank, otherwise null. */
  onFailure() {
    this.cleanRun = 0;
    const next = Math.max(this.min, Math.floor(this.value / 2));
    if (next === this.value) return null;
    this.value = next;
    return this.value;
  }

  reset(value = this.max) {
    this.value = Math.max(this.min, Math.min(this.max, value));
    this.cleanRun = 0;
    this.lastGrowAt = 0;
  }
}

/**
 * Descriptors for every chunk of a file. No bytes are read here — the engine
 * slices on demand so memory stays bounded.
 */
export function describeChunks(file, chunkSize) {
  const size = Number(file?.size) || 0;
  const step = Math.max(1, Number(chunkSize) || CHUNK_MIN);
  const chunks = [];
  for (let offset = 0, index = 0; offset < size; offset += step, index++) {
    const end = Math.min(size, offset + step);
    chunks.push({ index, offset, end, byteLength: end - offset });
  }
  return chunks;
}
