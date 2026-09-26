/* Eastudy V3 — hasher facade.
   One long-lived worker, multiplexed by id, so hashing never blocks the UI
   and we do not pay worker startup per file. */

const WORKER_URL = new URL('./hash-worker.js', import.meta.url);
let worker = null;
let seq = 0;
const inflight = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_URL);
  worker.onmessage = ({ data }) => {
    const entry = inflight.get(data.id);
    if (!entry) return;
    if (data.type === 'progress') entry.onProgress?.(data.loaded, data.total);
    else if (data.type === 'done') { inflight.delete(data.id); entry.resolve(data.sha256); }
    else if (data.type === 'error') {
      inflight.delete(data.id);
      entry.reject(new Error(data.aborted ? 'ABORTED' : data.message));
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'hash worker failed');
    for (const entry of inflight.values()) entry.reject(error);
    inflight.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Hash a Blob/File. Reads happen in the worker; only the digest crosses back. */
export function sha256(file, { onProgress, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('ABORTED'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    inflight.set(id, { resolve, reject, onProgress });
    signal?.addEventListener('abort', () => {
      if (!inflight.delete(id)) return;
      reject(new Error('ABORTED'));
    }, { once: true });
    ensureWorker().postMessage({ id, file });
  });
}

/** Hash one chunk. Chunk hashes are small, so this is cheap. */
export function sha256Hex(buffer) {
  return crypto.subtle.digest('SHA-256', buffer).then((d) =>
    Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''));
}

export function disposeHasher() {
  worker?.terminate();
  worker = null;
  inflight.clear();
}
