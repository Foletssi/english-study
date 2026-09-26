/* Eastudy V3 — status badges, in one place.

   The content state machine (DRAFT → PROCESSING → REVIEW → PUBLISHED →
   ARCHIVED) and the orthogonal pipeline status (WAITING / READY / FAILED) are
   rendered from a single map here. The legacy had the same five Chinese labels
   duplicated in four files with two spellings. */

import { el } from '../core/dom.js';

export const CONTENT_STATUS = {
  DRAFT: { label: '草稿', tone: 'neutral' },
  PROCESSING: { label: '处理中', tone: 'busy' },
  REVIEW: { label: '待审核', tone: 'warn' },
  PUBLISHED: { label: '已发布', tone: 'ok' },
  ARCHIVED: { label: '已下架', tone: 'muted' },
};

export const PIPELINE_STATUS = {
  WAITING: { label: '等待处理', tone: 'neutral' },
  READY: { label: '已就绪', tone: 'ok' },
  FAILED: { label: '处理失败', tone: 'danger' },
};

export const JOB_STATE = {
  WAITING: { label: '排队中', tone: 'neutral' },
  RUNNING: { label: '处理中', tone: 'busy' },
  SUCCEEDED: { label: '已完成', tone: 'ok' },
  FAILED: { label: '失败', tone: 'danger' },
  CANCELLED: { label: '已取消', tone: 'muted' },
};

export function badge(text, tone = 'neutral', { title } = {}) {
  return el('span', { class: `badge badge--${tone}`, title }, text);
}

export function statusBadge(status) {
  const spec = CONTENT_STATUS[status] || { label: status || '未知', tone: 'neutral' };
  return badge(spec.label, spec.tone);
}

export function pipelineBadge(status) {
  const spec = PIPELINE_STATUS[status] || PIPELINE_STATUS.WAITING;
  return badge(spec.label, spec.tone);
}

export function jobBadge(state, { stalled = false } = {}) {
  if (stalled) return badge('疑似卡住', 'danger', { title: '任务租约已过期,可在处理队列重试' });
  const spec = JOB_STATE[state] || { label: state || '未知', tone: 'neutral' };
  return badge(spec.label, spec.tone);
}

/** Small horizontal progress bar used by the job list. */
export function progressBar(value, { max = 100, label = null } = {}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return el('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
    el('div', { class: 'progress__fill', style: { width: `${pct.toFixed(1)}%` } }),
    label ? el('span', { class: 'progress__label' }, label) : null,
  );
}
