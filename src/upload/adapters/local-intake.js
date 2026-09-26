/* Eastudy V3 — local intake adapter.

   Speaks the V3 intake protocol (services/intake). Kept separate from the
   engine so the engine can be unit-tested against a fake transport, and so a
   cloud-direct adapter can be added later without touching scheduling logic.

   Protocol (v3):
     POST   /v3/sessions              open or reattach        -> {uploadId, chunkBytes, received[]}
     PUT    /v3/sessions/:id/chunks/:index                    -> {index, sha, bytes}
     PUT    /v3/sessions/:id/cover                            -> {sha}
     POST   /v3/sessions/:id/complete -> {state, job?, verifiedChunks}
     GET    /v3/sessions/:id          -> {state, received[]}   (poll during VERIFYING)
     DELETE /v3/sessions/:id          -> cancel
*/

import { ApiError } from '../../core/http.js';

const ERROR_MESSAGES = {
  INTAKE_QUEUE_FULL: '本机已有两个视频在等待接收，请等当前任务完成。',
  INTAKE_DISK_LOW: '本机磁盘空间不足，请清理后重试。',
  SOURCE_SHA_MISMATCH: '原视频校验失败。请确认选择的是同一个文件。',
  SOURCE_DECLARATION_CONFLICT: '所选文件与原任务不一致，请选择原文件。',
  INTAKE_TICKET_INVALID: '本机连接验证已过期，正在重新建立连接。',
  INTAKE_DISABLED: '本机接收功能未启用。',
  INTAKE_NOT_READY: '本机制作组件尚未就绪，请启动处理服务后重新检测。',
  WORKER_MISMATCH: '请在接收原视频的同一台电脑上恢复任务。',
  CHUNK_SHA_MISMATCH: '接收到的分片校验失败，正在重传该分片。',
  CHUNK_RANGE_INVALID: '分片范围无效，已重新协商分片大小。',
  SESSION_NOT_FOUND: '本机接收会话已失效，正在重新建立。',
  JOB_ALREADY_COMPLETE: '该视频已完成处理，请刷新任务查看结果。',
  CHUNK_TOO_LARGE: '分片过大，已自动减小分片大小。',
  LOCAL_CONNECTION_FAILED: '无法连接本机处理服务。请保持电脑运行并允许浏览器访问本地网络；已接收部分会保留。',
};

export function describeIntakeError(error) {
  if (!(error instanceof ApiError)) return error;
  const message = ERROR_MESSAGES[error.code];
  if (message) return new ApiError(error.code, { ...error, message });
  if (error.code === 'NETWORK') return new ApiError('LOCAL_CONNECTION_FAILED', { ...error, message: ERROR_MESSAGES.LOCAL_CONNECTION_FAILED });
  return error;
}

export function createLocalIntakeAdapter({ baseUrl, ticketProvider, capabilityProvider, fetchImpl = fetch }) {
  async function call(path, { method = 'GET', body, headers = {}, signal, timeout = 120_000 } = {}) {
    const ticket = await ticketProvider();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeout);
    const forward = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forward, { once: true });

    let response;
    try {
      response = await fetchImpl(baseUrl.replace(/\/$/, '') + path, {
        method,
        body,
        headers: { ...headers, ...(ticket ? { Authorization: `Bearer ${ticket}` } : {}) },
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError('NETWORK', { message: ERROR_MESSAGES.LOCAL_CONNECTION_FAILED });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(payload?.error || `HTTP_${response.status}`, { status: response.status, detail: payload });
    }
    return payload;
  }

  return {
    /** Open or reattach a session. Server decides the authoritative chunk size. */
    async open({ descriptor, file, video, cover, recoveryJobId, resume }) {
      const capability = await capabilityProvider();
      if (!capability?.ready) throw new ApiError('INTAKE_NOT_READY', { message: ERROR_MESSAGES.INTAKE_NOT_READY });

      return call('/sessions', {
        method: 'POST',
        body: JSON.stringify({
          video,
          resume: Boolean(resume),
          recoveryJobId,
          source: {
            name: file.name,
            size: file.size,
            sha256: descriptor.sha256 || null,
            lastModified: file.lastModified,
          },
          hasCover: Boolean(cover?.size),
          chunkSizeHint: descriptor.chunkSize,
          workerId: capability.workerId,
          challenge: capability.challenge,
          origin: location.origin,
        }),
      });
    },

    async sendChunk({ uploadPath, index, buffer, sha256: chunkSha, signal }) {
      return call(`${uploadPath}/chunks/${index}`, {
        method: 'PUT',
        body: buffer,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Chunk-SHA256': chunkSha,
        },
        signal,
        timeout: 300_000,
      });
    },

    async sendCover({ uploadPath, cover, sha256: coverSha }) {
      const buffer = await cover.arrayBuffer();
      return call(`${uploadPath}/cover`, {
        method: 'PUT',
        body: buffer,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': coverSha },
        timeout: 120_000,
      });
    },

    /** Commit, then poll while the server verifies the assembled file. */
    async complete({ uploadPath, sha256: fileSha, coverSha256, onVerifyProgress }) {
      let result = await call(`${uploadPath}/complete`, {
        method: 'POST',
        body: JSON.stringify({ sha256: fileSha, coverSha256 }),
        timeout: 600_000,
      });

      const deadline = Date.now() + 30 * 60_000;
      let wait = 1200;
      while (result?.state === 'VERIFYING') {
        if (Date.now() > deadline) throw new ApiError('VERIFY_TIMEOUT', { message: '本机核验超时，已接收部分已保留，可稍后继续。' });
        onVerifyProgress?.({ phase: 'verifying', verifyProgress: result.verifyProgress ?? null });
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = Math.min(5000, Math.round(wait * 1.4));
        result = await call(uploadPath, { timeout: 60_000 });
      }

      if (result?.state !== 'READY') {
        const code = result?.error || 'INTAKE_INCOMPLETE';
        throw new ApiError(code, { message: ERROR_MESSAGES[code] || '原片未接收完整，可继续上传。' });
      }
      return result;
    },

    async status({ uploadPath }) {
      return call(uploadPath, { timeout: 30_000 });
    },

    async cancel({ uploadPath }) {
      return call(uploadPath, { method: 'DELETE', timeout: 30_000 });
    },
  };
}
