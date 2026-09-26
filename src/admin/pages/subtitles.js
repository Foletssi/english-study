/* Eastudy V3 — 字幕审核 (M07/M08 handoff).

   The review surface where a human fixes what the pipeline produced. Two rules
   from the module spec drive the whole design:

   - Editing is optimistic-concurrency safe: every save carries the subtitle
     revision, and the server compares it plus the R2 ETag. A stale save is
     rejected with the current document rather than silently winning.
   - Saving subtitles does not change the video's publish state. The legacy
     coupled them, so fixing a typo could push a draft live. */

import { el, mount, setText } from '../../core/dom.js';
import { emptyState, errorState, toast } from '../../ui/index.js';
import { confirm } from '../../ui/modal.js';
import { describeError } from '../../services/index.js';
import { duration as formatTime } from '../../core/format.js';

export function createSubtitlesPage({ api, media, navigate, params }) {
  const videoId = params?.id || '';
  let revision = 0;
  let sentences = [];
  let dirty = false;

  const titleSlot = el('h1', { class: 'page__title' }, '字幕审核');
  const statusSlot = el('div', { class: 'review__status' });
  const listSlot = el('div', { class: 'review__list' });
  const saveButton = el('button', { class: 'btn btn--primary', type: 'button', disabled: true, on: { click: save } }, '保存');
  const revertButton = el('button', { class: 'btn btn--ghost', type: 'button', on: { click: () => reload() } }, '放弃修改');

  const root = el('div', { class: 'page review' },
    el('header', { class: 'page__head' },
      titleSlot,
      el('p', { class: 'page__subtitle' }, '校对自动识别的字幕。保存不会改变视频的发布状态。'),
      el('div', { class: 'page__actions' }, revertButton, saveButton),
    ),
    statusSlot,
    listSlot,
  );

  function markDirty() {
    dirty = true;
    saveButton.disabled = false;
    setText(statusSlot, `有未保存的修改 · 当前版本 r${revision}`);
  }

  async function reload() {
    if (dirty && !(await confirm({ title: '放弃修改', message: '未保存的修改会丢失。', confirmLabel: '放弃', danger: true }))) return;
    await load();
  }

  async function load() {
    if (!videoId) {
      mount(listSlot, emptyState({ title: '没有指定视频', hint: '请从视频列表进入字幕审核。' }));
      return;
    }
    mount(listSlot, el('div', { class: 'skeleton skeleton--rows' }));
    try {
      const payload = await api.get(`/api/admin/subtitles/${encodeURIComponent(videoId)}`);
      revision = payload.revision ?? 0;
      sentences = payload.sentences ?? [];
      setText(titleSlot, `字幕审核 · ${payload.title || '未命名'}`);
      setText(statusSlot, `版本 r${revision} · 共 ${sentences.length} 句`);
      dirty = false;
      saveButton.disabled = true;
      render();
    } catch (error) {
      mount(listSlot, errorState({ message: describeError(error), onRetry: load }));
    }
  }

  function render() {
    if (!sentences.length) {
      mount(listSlot, emptyState({
        title: '还没有字幕',
        hint: '等待语音识别完成,或检查处理队列中的任务状态。',
        action: el('button', { class: 'btn btn--ghost', type: 'button', on: { click: () => navigate('/admin/jobs') } }, '查看处理队列'),
      }));
      return;
    }
    mount(listSlot, el('ol', { class: 'review-list' }, ...sentences.map((sentence, index) => row(sentence, index))));
  }

  function row(sentence, index) {
    const start = el('input', {
      class: 'input input--time', type: 'text', value: formatTime(sentence.start),
      'aria-label': `第 ${index + 1} 句开始时间`,
      on: { change: () => { sentence.start = parseTime(start.value, sentence.start); markDirty(); } },
    });
    const end = el('input', {
      class: 'input input--time', type: 'text', value: formatTime(sentence.end),
      'aria-label': `第 ${index + 1} 句结束时间`,
      on: { change: () => { sentence.end = parseTime(end.value, sentence.end); markDirty(); } },
    });
    const text = el('textarea', {
      class: 'input input--sentence', rows: '2', 'aria-label': `第 ${index + 1} 句原文`,
      on: { input: () => { sentence.text = text.value; markDirty(); } },
    }, sentence.text || '');
    const translation = el('textarea', {
      class: 'input input--sentence', rows: '2', placeholder: '译文(可留空)',
      'aria-label': `第 ${index + 1} 句译文`,
      on: { input: () => { sentence.translation = translation.value; markDirty(); } },
    }, sentence.translation || '');

    return el('li', { class: 'review-row', dataset: { index: String(index) } },
      el('div', { class: 'review-row__times' },
        el('button', {
          class: 'review-row__play', type: 'button', 'aria-label': '试听',
          on: { click: () => preview(sentence) },
        }, '▶'),
        start, el('span', { class: 'review-row__dash' }, '–'), end,
      ),
      el('div', { class: 'review-row__texts' }, text, translation),
      el('div', { class: 'review-row__ops' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          on: { click: () => { const merged = sentences[index + 1]; if (merged) { sentence.text = `${sentence.text} ${merged.text}`.trim(); sentence.end = merged.end; sentences.splice(index + 1, 1); markDirty(); render(); } } },
        }, '与下一句合并'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          on: {
            click: () => {
              // Split at the caret, so the operator does not retype both halves.
              const caret = text.selectionStart;
              if (caret <= 0 || caret >= sentence.text.length) { toast('请先把光标放在要拆分的位置。', { variant: 'warn' }); return; }
              const head = sentence.text.slice(0, caret).trim();
              const tail = sentence.text.slice(caret).trim();
              const midpoint = sentence.start + (sentence.end - sentence.start) * (caret / sentence.text.length);
              sentence.text = head;
              const copy = { ...sentence, text: tail, start: midpoint, id: undefined };
              sentence.end = midpoint;
              sentences.splice(index + 1, 0, copy);
              markDirty();
              render();
            },
          },
        }, '拆分'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          on: { click: () => { sentences.splice(index, 1); markDirty(); render(); } },
        }, '删除'),
      ),
    );
  }

  /* 试听 one sentence.

     The audio arrives whole as a blob URL (see services/media.js) and this
     element seeks inside it, rather than the server slicing a window per
     request. Two reasons that ordering matters: the browser cannot send our
     Authorization header on an <audio> element's own request, and a fresh
     download per sentence would re-fetch the file on every click.

     One element is reused for the whole session. Creating a new Audio per
     click leaked a decoder each time and let two sentences play over each
     other when an operator clicked twice quickly. */
  let audioEl = null;
  let audioUrl = null;
  // Guards against a slow first fetch: click sentence A (fetch starts), click
  // B (fetch still running), then A's blob lands and plays over B.
  let previewToken = 0;

  function stopPreview() {
    if (!audioEl) return;
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
  }

  async function preview(sentence) {
    const token = ++previewToken;
    stopPreview();
    setText(statusSlot, '正在载入试听音频…');

    let entry;
    try {
      entry = await media.preview(videoId);
    } catch (error) {
      if (token !== previewToken) return;
      setText(statusSlot, dirty ? `有未保存的修改 · 当前版本 r${revision}` : `当前版本 r${revision}`);
      toast(describeError(error), { variant: 'warn' });
      return;
    }
    if (token !== previewToken) return;      // a newer click won

    if (!audioEl || audioUrl !== entry.url) {
      audioUrl = entry.url;
      audioEl = new Audio(entry.url);
      // Browsers refuse a seek on a resource whose metadata has not loaded, and
      // setting currentTime before then silently resets to 0 — which plays the
      // first line of the video instead of the one being corrected.
      audioEl.preload = 'auto';
    }

    const start = Math.max(0, Number(sentence.start) || 0);
    const end = Math.max(start, Number(sentence.end) || start);

    const play = () => {
      if (token !== previewToken) return;
      if (Number.isFinite(end) && end > start) {
        audioEl.currentTime = start;
        // Stop at the cue's end so the operator hears the sentence, not the
        // rest of the video. `timeupdate` is coarse (4-66ms), so the cut is
        // approximate — the alternative is an rAF loop for no audible gain.
        audioEl.ontimeupdate = () => {
          if (audioEl.currentTime >= end) { audioEl.pause(); audioEl.ontimeupdate = null; }
        };
      }
      audioEl.play().catch(() => {
        if (token !== previewToken) return;
        toast('无法试听,请确认视频已处理完成。', { variant: 'warn' });
      });
    };

    if (audioEl.readyState >= 1) play();
    else {
      audioEl.onloadedmetadata = () => { audioEl.onloadedmetadata = null; play(); };
      audioEl.onerror = () => {
        audioEl.onerror = null;
        if (token !== previewToken) return;
        toast('无法试听,音频文件无法播放。', { variant: 'warn' });
      };
    }
  }

  async function save() {
    saveButton.disabled = true;
    setText(saveButton, '保存中…');
    try {
      const payload = await api.put(`/api/admin/subtitles/${encodeURIComponent(videoId)}`, {
        revision,
        sentences: sentences.map((sentence, index) => ({
          index,
          start: round(sentence.start),
          end: round(sentence.end),
          text: sentence.text,
          translation: sentence.translation || null,
        })),
      }, { retry: false });
      revision = payload.revision ?? revision + 1;
      dirty = false;
      setText(statusSlot, `已保存 · 版本 r${revision}`);
      toast('字幕已保存', { variant: 'success' });
    } catch (error) {
      if (error?.status === 409) {
        toast('字幕已被其他人修改,已载入最新版本。', { variant: 'warn' });
        await load();
        return;
      }
      toast(describeError(error), { variant: 'error' });
      saveButton.disabled = false;
    } finally {
      setText(saveButton, '保存');
    }
  }

  // Warn before leaving with unsaved work. The router asks the page first.
  // Named so unmount can remove it — the legacy registered an anonymous handler
  // on every visit, so after a few round trips through the review screen the
  // tab asked for confirmation several times over.
  function warnBeforeUnload(event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  }
  window.addEventListener('beforeunload', warnBeforeUnload);

  return {
    root,
    async mount() { await load(); },
    unmount() {
      // Stop playback and release the element's blob reference. The blob itself
      // stays cached in the media service, so coming back to this video does not
      // re-download the audio.
      previewToken += 1;
      stopPreview();
      audioEl = null;
      window.removeEventListener('beforeunload', warnBeforeUnload);
    },
    get dirty() { return dirty; },
  };
}

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function parseTime(input, fallback) {
  const parts = String(input).trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return fallback;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  const numeric = Number(input);
  return Number.isNaN(numeric) ? fallback : numeric;
}
