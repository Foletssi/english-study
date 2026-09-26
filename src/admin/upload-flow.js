/* Eastudy V3 — the upload flow.

   This is the piece the operator asked to have rebuilt: the control-end upload
   must be fast, must survive interruption, and must resume without re-sending
   bytes it already sent.

   How it works, in order:

   1. `reserve` — ask the edge API for a handshake challenge. The edge API is
      the only party that can prove the caller is an admin, and the local intake
      service is the only party that can accept bytes. The challenge is the
      bridge between them.
   2. `open` — the engine hashes the file while it uploads, so the hash is not a
      gate in front of the transfer. Chunks that already exist on the intake
      service are reported as present and skipped.
   3. `send` — N chunks in flight, where N is chosen by the AIMD governor: it
      grows while chunks complete on time and halves on a failure, so a fast
      link gets parallelism and a flaky one backs off instead of piling on.
   4. `complete` — the server assembles the chunks, re-hashes the result, and
      only then writes the receipt. A hash that disagrees keeps the chunks and
      returns the session to RECEIVING, so the retry does not start over.

   The resume ledger lives in IndexedDB keyed by
   `adminId + videoId + name + size + sha256`, so closing the browser and
   reopening the page finds the same session — and the intake service's own
   session store is the second half of that guarantee if the browser storage
   was cleared. */

import { el, mount, setText } from '../core/dom.js';
import { toast } from '../ui/toast.js';
import { createUploadPanel } from '../ui/upload-panel.js';
import { UploadEngine } from '../upload/engine.js';
import { createLocalIntakeAdapter } from '../upload/adapters/local-intake.js';
import { openSession, dropSession, pruneStale, confirmedChunks } from '../upload/resume-ledger.js';
import { describeError } from '../services/index.js';
import { environment } from '../config/environment.js';

export function createUploadFlow({ video, session: authSession, api, onDone }) {
  const status = el('p', { class: 'upload__status' });
  const resumeSlot = el('div', { class: 'upload__resume' });

  const panel = createUploadPanel({
    onChoose: (file) => start(file),
    onCancel: () => engine?.cancel(),
    onResume: () => resumeSlot.querySelector('input')?.click(),
  });

  const hiddenResumeInput = el('input', {
    type: 'file', accept: 'video/*', class: 'visually-hidden',
    on: { change: (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) start(file);
    } },
  });
  resumeSlot.appendChild(hiddenResumeInput);

  const root = el('div', { class: 'upload-flow' },
    el('div', { class: 'upload-flow__video' },
      el('span', { class: 'upload-flow__label' }, '目标视频'),
      el('span', { class: 'upload-flow__name' }, video.title || '未命名'),
    ),
    status,
    panel.root,
    resumeSlot,
  );

  let engine = null;
  let disposed = false;

  // Housekeeping: sessions older than a day are dead weight in IndexedDB.
  pruneStale(24 * 60 * 60 * 1000).catch(() => {});

  async function start(file) {
    if (disposed) return;
    if (file.size > 2 * 1024 ** 3) {
      panel.fail({ message: '单个原片不能超过 2 GiB。' });
      return;
    }

    setText(status, '正在与处理服务握手…');

    let challenge;
    try {
      challenge = await api.post('/api/intake/challenge', { video_id: video.id }, { retry: false });
    } catch (error) {
      setText(status, '');
      panel.fail({ message: `无法连接处理服务:${describeError(error)}` });
      return;
    }

    setText(status, `处理服务:${challenge.intake?.url || environment.intakeUrl}`);

    const adminId = challenge.adminId || authSession?.user?.id;

    const adapter = createLocalIntakeAdapter({
      baseUrl: challenge.intake?.url || environment.intakeUrl,
      ticketProvider: async () => {
        // Tickets are short-lived by design; refresh from the broker rather
        // than caching one for the whole upload.
        const fresh = await api.post('/api/intake/challenge', { video_id: video.id }, { retry: false });
        return fresh.challenge;
      },
      capabilityProvider: async () => challenge.capabilities,
    });

    engine = new UploadEngine({
      file,
      videoId: video.id,
      adminId,
      adapter,
      ledger: { openSession, dropSession, confirmedChunks },
      onProgress: (state) => panel.update(state),
    });

    try {
      const result = await engine.start();
      if (disposed) return;
      setText(status, '传输完成,正在等待服务端核验…');
      toast('原片已送达处理服务,接下来会自动排队处理。', { variant: 'success', duration: 6000 });
      await api.post(`/api/admin/videos/${video.id}/source-received`, {
        source_sha256: result?.sha256,
        source_bytes: file.size,
        source_name: file.name,
      }, { retry: false }).catch(() => {});
      onDone?.(result);
    } catch (error) {
      if (disposed) return;
      if (error?.code === 'CANCELLED') {
        setText(status, '已暂停。重新选择同一个文件会从断点继续。');
        panel.fail({ message: '上传已暂停,可以继续。' });
        return;
      }
      setText(status, '');
      panel.fail({ message: describeIntakeMessage(error) });
    }
  }

  async function resume(file) {
    return start(file);
  }

  return {
    root,
    resume,
    dispose() {
      disposed = true;
      engine?.cancel?.();
      panel.dispose();
    },
  };
}

function describeIntakeMessage(error) {
  if (!error) return '上传中断,可以继续。';
  if (error.code === 'INSUFFICIENT_STORAGE') return '处理服务所在磁盘空间不足,请清理后重试。';
  if (error.code === 'SESSION_LIMIT') return '处理服务同时进行的上传任务已满,请稍后再试。';
  if (error.code === 'SOURCE_TOO_LARGE') return '原片超出处理服务允许的大小。';
  if (error.code === 'CHUNK_SHA_MISMATCH') return '文件校验不一致,可能是本地文件已损坏。';
  if (error.code === 'UNAUTHORIZED') return '处理服务的凭据已过期,请刷新页面后重试。';
  return describeError(error);
}

/** Exposed for the queue page, which shows "上传中断" rows and offers resume. */
export function describeResumeHint(sessionRow) {
  if (!sessionRow) return '';
  const { received = 0, total = 0 } = sessionRow;
  return `已接收 ${received}/${total} 个分片`;
}

void mount;
void openSession;
