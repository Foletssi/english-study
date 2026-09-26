/* Eastudy V3 — parallel resumable upload engine.

   Replaces admin/assets/local-processing-client.js. What changed and why:

   1. No blocking pre-hash. The legacy hashed the whole 2 GB file before the
      first byte moved. Here the file hash is computed *in parallel with*
      upload and is only needed at commit time, so time-to-first-byte is
      driven by network, not disk.
   2. Parallel chunks. The legacy sent one PUT at a time. Workers here pull
      from a shared queue, with a governor that grows concurrency while chunks
      land and halves it on failure.
   3. Per-chunk hashes computed in parallel with transfer, from the same
      buffer that is being sent, so no chunk is read twice.
   4. Durable resume. Progress is written to IndexedDB per chunk; a reload
      re-reads the ledger and skips confirmed chunks instead of re-hashing.
   5. Bounded memory. At most `maxConcurrency` chunks of at most 64 MiB are
      in flight, so a 2 GB upload never approaches memory limits.

   The engine is transport-agnostic: it talks to an `adapter` that knows how
   to open a session, send one chunk, and finalise. */

import { emit, EVENTS } from '../core/bus.js';
import { ApiError, sleep, withRetry } from '../core/http.js';
import { sha256, sha256Hex } from './hasher.js';
import { ConcurrencyGovernor, describeChunks, planChunks } from './chunk-plan.js';
import {
  confirmedChunks, dropSession, loadSession, openSession, pruneStale,
  recordChunk, saveSession, sessionKey,
} from './resume-ledger.js';

export class UploadCancelled extends Error {
  constructor() { super('上传已取消'); this.name = 'UploadCancelled'; }
}

export class UploadEngine {
  /**
   * @param {object} options
   * @param {object} options.adapter   transport (see adapters/local-intake.js)
   * @param {string} options.adminId
   * @param {string} [options.videoId]
   * @param {number} [options.maxConcurrency]
   * @param {(state: object) => void} [options.onProgress]
   */
  constructor({ adapter, adminId, videoId = null, maxConcurrency = 8, onProgress } = {}) {
    this.adapter = adapter;
    this.adminId = adminId;
    this.videoId = videoId;
    this.governor = new ConcurrencyGovernor({ initial: 4, min: 1, max: maxConcurrency });
    this.onProgress = onProgress;
    this.state = null;
    this.abort = new AbortController();
  }

  cancel() {
    this.abort.abort(new UploadCancelled());
  }

  /** Publish a progress snapshot to both the bus and the caller. */
  #report(patch) {
    Object.assign(this.state, patch);
    this.state.speedBytesPerSecond = this.#measureSpeed();
    const snapshot = { ...this.state, percent: this.#percent() };
    this.onProgress?.(snapshot);
    emit(EVENTS.UPLOAD_CHANGED, snapshot);
  }

  #percent() {
    const { sentBytes, totalBytes, phase } = this.state;
    if (phase === 'hashing' || phase === 'preparing') {
      // Hashing shares the bar's first 5%; the rest is transfer + verify.
      return Math.min(5, Math.round((this.state.hashLoaded / Math.max(1, totalBytes)) * 5));
    }
    if (phase === 'verifying') return 99;
    if (phase === 'done') return 100;
    if (!totalBytes) return 0;
    return Math.min(98, 5 + Math.round((sentBytes / totalBytes) * 93));
  }

  #measureSpeed() {
    const now = Date.now();
    const window = this.speedWindow ??= [];
    window.push({ at: now, bytes: this.state.sentBytes });
    while (window.length > 1 && now - window[0].at > 5000) window.shift();
    const first = window[0];
    const elapsed = (now - first.at) / 1000;
    if (elapsed < 1) return this.state.speedBytesPerSecond ?? 0;
    return (this.state.sentBytes - first.bytes) / elapsed;
  }

  async #hashFile(file) {
    this.#report({ phase: 'hashing', hashLoaded: 0 });
    const digest = await sha256(file, {
      signal: this.abort.signal,
      onProgress: (loaded) => this.#report({ hashLoaded: loaded }),
    });
    this.#report({ sha256: digest, hashLoaded: file.size });
    return digest;
  }

  /**
   * Run an upload. Safe to call again after a network drop or a page reload:
   * the same descriptor reattaches to the existing session.
   */
  async run({ file, video = {}, cover = null, recoveryJobId = null } = {}) {
    if (!file?.size) throw new Error('请选择原视频文件。');
    if (file.size > 2 * 1024 ** 3) throw new Error('原视频不能超过 2GB。');
    if (cover?.size > 15 * 1024 ** 2) throw new Error('封面不能超过 15MB。');

    this.state = {
      phase: 'preparing', fileName: file.name, totalBytes: file.size,
      sentBytes: 0, chunkCount: 0, confirmedCount: 0, hashLoaded: 0,
      sha256: null, speedBytesPerSecond: 0, startedAt: Date.now(),
      resumed: false, verifiedChunks: 0, concurrency: this.governor.value,
      completedChunks: 0, totalChunks: 0, retrying: false, error: null,
    };
    this.#report({});

    await pruneStale().catch(() => 0);

    // Hash first ONLY when the identity is unknown; otherwise we can start
    // moving bytes immediately and hash concurrently.
    const knownSha = await this.#resolveIdentity(file, video, recoveryJobId);

    const { chunkSize, count } = planChunks(file.size);
    const descriptor = {
      sessionId: sessionKey({ adminId: this.adminId, videoId: recoveryJobId || video.id, name: file.name, size: file.size, sha256: knownSha }),
      adminId: this.adminId,
      videoId: recoveryJobId || video.id || null,
      name: file.name,
      size: file.size,
      chunkSize,
      sha256: knownSha,
    };
    const session = await openSession(descriptor);
    const resumed = (session.uploadedBytes || 0) > 0;
    this.#report({ resumed, chunkCount: count, chunkSize, sha256: knownSha });

    const hashing = knownSha
      ? Promise.resolve(knownSha)
      : this.#hashFile(file).then(async (digest) => {
          // The hash changes the resume key, so adopt it now that it is known.
          await saveSession({ sessionId: descriptor.sessionId, sha256: digest });
          return digest;
        });

    const local = await confirmedChunks(descriptor.sessionId);

    // Ask the server what it already holds. The server is authoritative; the
    // ledger is a hint that avoids re-hashing chunks we already verified.
    const remote = await this.#call(() => this.adapter.open({
      descriptor, file, video, cover, recoveryJobId, resume: resumed,
    }));
    const { uploadPath, chunkBytes, received } = remote;

    const effectiveChunkSize = chunkBytes || chunkSize;
    const chunks = describeChunks(file, effectiveChunkSize);
    this.#report({ chunkCount: chunks.length, chunkSize: effectiveChunkSize });

    // Reconcile: server says what it actually has; ledger says what we think
    // we sent. Trust the server for existence, the ledger for correctness.
    const serverHas = new Map((received || []).map((row) => [row.idx, row.sha]));
    let already = 0;
    for (const [index] of serverHas) if (local.has(index)) already++;
    this.#report({ confirmedCount: already, verifiedChunks: already });
    this.state.sentBytes = chunks.filter((c) => serverHas.has(c.index)).reduce((s, c) => s + c.byteLength, 0);

    const queue = chunks.filter((chunk) => !serverHas.has(chunk.index) || serverHas.get(chunk.index) !== local.get(chunk.index));
    if (queue.length === 0) {
      this.#report({ phase: 'verifying', sentBytes: file.size });
    } else {
      this.#report({ phase: 'uploading' });
      await this.#drain({ file, queue, uploadPath, sessionId: descriptor.sessionId });
    }

    // Wait for the file hash before committing; the server verifies
    // source_sha256 at completion and a mismatch wastes the whole transfer.
    const digest = await hashing;
    this.#report({ phase: 'verifying', sentBytes: file.size });

    let coverSha = null;
    if (cover?.size) {
      coverSha = await sha256(cover, { signal: this.abort.signal });
      await this.#call(() => this.adapter.sendCover({ uploadPath, cover, sha256: coverSha }));
    }

    const result = await this.#call(() => this.adapter.complete({
      uploadPath, sha256: digest, coverSha256: coverSha,
      onVerifyProgress: (state) => this.#report(state),
    }));

    await saveSession({ sessionId: descriptor.sessionId, completedAt: Date.now() });
    this.#report({ phase: 'done', sentBytes: file.size, result });
    this.state.result = result;
    // Free the ledger only after the server confirms; a failed commit must
    // leave the resume data intact.
    await dropSession(descriptor.sessionId).catch(() => {});
    return result;
  }

  /** Identity lets a re-selected file resume instead of duplicating a job. */
  async #resolveIdentity(file, video, recoveryJobId) {
    if (!recoveryJobId && !video.id) {
      // Brand-new upload: no prior session can exist, so hash before opening.
      return this.#hashFile(file);
    }
    const probeKey = sessionKey({ adminId: this.adminId, videoId: recoveryJobId || video.id, name: file.name, size: file.size });
    const prior = await loadSession(probeKey).catch(() => null);
    if (prior?.sha256) return prior.sha256;
    return this.#hashFile(file);
  }

  /** Shared work queue with adaptive worker count. */
  async #drain({ file, queue, uploadPath, sessionId }) {
    const pending = [...queue];
    const totalChunks = pending.length;
    let completed = 0;
    let fatal = null;
    const workers = new Set();

    const runWorker = async () => {
      while (pending.length && !fatal) {
        if (this.abort.signal.aborted) { fatal = new UploadCancelled(); return; }
        const chunk = pending.shift();
        try {
          await this.#sendChunk({ file, chunk, uploadPath, sessionId });
          completed++;
          const grown = this.governor.onSuccess();
          if (grown) this.#report({ concurrency: grown });
          this.#report({
            confirmedCount: this.state.confirmedCount + 1,
            completedChunks: completed,
            totalChunks,
          });
        } catch (error) {
          if (error instanceof UploadCancelled || this.abort.signal.aborted) {
            fatal = new UploadCancelled();
            return;
          }
          this.governor.onFailure();
          this.#report({ concurrency: this.governor.value });
          if (error instanceof ApiError && !error.retryable && error.status !== 0) {
            fatal = error; // 4xx that is not a rate limit: retrying cannot help.
            return;
          }
          // Transient: put the chunk back for another worker to try.
          pending.push(chunk);
          if (pending.length > totalChunks * 4) { fatal = error; return; }
          await sleep(300, this.abort.signal).catch(() => {});
        }
      }
    };

    const spawn = () => {
      const worker = runWorker().finally(() => workers.delete(worker));
      workers.add(worker);
    };

    // Keep the pool topped up as the governor moves the target.
    const target = this.governor.value;
    for (let i = 0; i < target; i++) spawn();
    while (workers.size && !fatal) {
      await Promise.race(workers);
      if (fatal) break;
      const want = this.governor.value;
      while (workers.size < want && pending.length) spawn();
      if (!workers.size && pending.length) for (let i = 0; i < Math.max(1, this.governor.value); i++) spawn();
    }
    await Promise.allSettled(workers);
    if (fatal) throw fatal;
  }

  async #sendChunk({ file, chunk, uploadPath, sessionId }) {
    const blob = file.slice(chunk.offset, chunk.end);
    const buffer = await blob.arrayBuffer();
    if (this.abort.signal.aborted) throw new UploadCancelled();
    const chunkSha = await sha256Hex(buffer);

    await withRetry(() => this.adapter.sendChunk({
      uploadPath,
      index: chunk.index,
      buffer,
      sha256: chunkSha,
      signal: this.abort.signal,
    }), {
      attempts: 4,
      baseMs: 500,
      signal: this.abort.signal,
      onRetry: () => {
        // Back off the whole pool, not just this chunk: a retry usually means
        // the link is saturated, and more workers would make it worse.
        this.governor.onFailure();
        this.#report({ retrying: true, concurrency: this.governor.value });
      },
    });

    await recordChunk(sessionId, chunk.index, chunkSha, chunk.byteLength);
    await saveSession({ sessionId, uploadedBytes: this.state.sentBytes + chunk.byteLength });
    this.state.sentBytes += chunk.byteLength;
  }

  async #call(fn) {
    return withRetry(fn, {
      attempts: 4,
      baseMs: 600,
      signal: this.abort.signal,
      onRetry: () => this.#report({ phase: this.state.phase, retrying: true }),
    });
  }
}
