/* Eastudy V3 — the upload surface.

   This is where the upload engine becomes something an operator can watch:
   a live phase, a speed, a time estimate, the current concurrency, and — when
   something goes wrong — a resume button that picks up exactly where it
   stopped rather than starting over. */

import { el, mount, setText } from '../core/dom.js';
import { EVENTS, off, on } from '../core/bus.js';
import { bytes, duration, eta, speed } from '../core/format.js';

const PHASE_LABEL = {
  preparing: '准备中',
  hashing: '正在校验原片',
  uploading: '正在传输',
  verifying: '正在核验',
  done: '已完成',
  failed: '已中断',
};

export function createUploadPanel({ onChoose, onCancel, onResume }) {
  const fileInput = el('input', {
    type: 'file',
    accept: 'video/*',
    class: 'visually-hidden',
    on: { change: (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) onChoose?.(file);
    } },
  });

  const phase = el('p', { class: 'upload__phase' }, '选择一个原视频开始');
  const bar = el('div', { class: 'upload__bar-fill', style: { width: '0%' } });
  const percentText = el('span', { class: 'upload__percent' }, '0%');
  const stats = el('dl', { class: 'upload__stats' });
  const notice = el('p', { class: 'upload__notice', hidden: true });
  const actions = el('div', { class: 'upload__actions' });

  const chooseButton = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    on: { click: () => fileInput.click() },
  }, '选择原视频');

  const cancelButton = el('button', {
    class: 'btn btn--ghost',
    type: 'button',
    hidden: true,
    on: { click: () => onCancel?.() },
  }, '暂停');

  const resumeButton = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    hidden: true,
    on: { click: () => onResume?.() },
  }, '继续上传');

  mount(actions, chooseButton, resumeButton, cancelButton);

  const root = el('section', { class: 'upload card' },
    el('header', { class: 'upload__head' },
      el('h2', { class: 'upload__title' }, '上传原片'),
      el('p', { class: 'upload__hint' }, '原片只会保存到本机,不会上传到云端。'),
    ),
    phase,
    el('div', { class: 'upload__bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar),
    el('div', { class: 'upload__meta' }, percentText),
    stats,
    notice,
    actions,
    fileInput,
  );

  let lastState = null;

  function renderStats(state) {
    const rows = [
      ['已传输', `${bytes(state.sentBytes)} / ${bytes(state.totalBytes)}`],
      ['速度', speed(state.speedBytesPerSecond)],
      ['剩余', eta(state.totalBytes - state.sentBytes, state.speedBytesPerSecond)],
      ['分片', `${state.completedChunks ?? 0} / ${state.totalChunks ?? state.chunkCount ?? 0}`],
    ];
    if (state.concurrency) rows.push(['并发', `${state.concurrency} 路`]);
    if (state.resumed) rows.push(['恢复', '已从断点继续']);

    mount(stats, ...rows.map(([label, value]) => el('div', { class: 'upload__stat' },
      el('dt', null, label),
      el('dd', null, value),
    )));
  }

  function render(state) {
    lastState = state;
    const label = PHASE_LABEL[state.phase] || state.phase;
    setText(phase, state.phase === 'uploading' && state.retrying ? `${label}(网络波动,正在重试)` : label);

    const width = `${state.percent ?? 0}%`;
    bar.style.width = width;
    setText(percentText, `${state.percent ?? 0}%`);
    root.querySelector('.upload__bar').setAttribute('aria-valuenow', String(state.percent ?? 0));

    renderStats(state);

    const failed = state.phase === 'failed';
    notice.hidden = !failed && !state.resumed;
    if (failed) {
      setText(notice, describeFailure(state.error));
      notice.className = 'upload__notice upload__notice--error';
    } else if (state.resumed) {
      setText(notice, '已检测到未完成的上传,将从断点继续,不会重复传输已完成的字节。');
      notice.className = 'upload__notice upload__notice--info';
    }

    cancelButton.hidden = !['hashing', 'uploading', 'preparing', 'verifying'].includes(state.phase);
    resumeButton.hidden = !failed && state.phase !== 'done';
    resumeButton.textContent = failed ? '重新选择原片继续' : '继续上传';
    chooseButton.hidden = ['hashing', 'uploading', 'preparing', 'verifying'].includes(state.phase);
  }

  const unsubscribe = on(EVENTS.UPLOAD_CHANGED, render);

  return {
    root,
    update: render,
    fail(error) {
      render({ ...(lastState || { percent: 0, totalBytes: 0, sentBytes: 0 }), phase: 'failed', error });
    },
    dispose() { off(EVENTS.UPLOAD_CHANGED, render); unsubscribe?.(); },
  };
}

function describeFailure(error) {
  if (!error) return '上传中断,可以继续。';
  if (typeof error === 'string') return error;
  return error.message || '上传中断,可以继续。';
}
