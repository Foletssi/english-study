/* Eastudy V3 — 处理队列 (M08).

   One card per video, which is what the operator actually manages. The legacy
   listed jobs, so a video retried eleven times produced eleven cards and the
   operator could not tell whether the video was stuck or the queue was busy.

   The server does the grouping (page over videos in PROCESSING/REVIEW, then
   attach the newest job); this page adds the controls: retry, cancel, and a
   clear marker for a job whose lease expired while it still claims RUNNING. */

import { el, mount } from '../../core/dom.js';
import { createListController, emptyState, errorState, pagination, progressBar, toast } from '../../ui/index.js';
import { confirm } from '../../ui/modal.js';
import { jobBadge, statusBadge } from '../../ui/status.js';
import { describeError } from '../../services/index.js';

export function createJobsPage({ jobs, navigate }) {
  const summarySlot = el('div', { class: 'queue__summary' });
  const listSlot = el('div', { class: 'queue__list' });
  const pagerSlot = el('div');
  let onlyStalled = false;

  const stalledToggle = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    'aria-pressed': 'false',
    on: { click: () => { onlyStalled = !onlyStalled; syncToggle(); list.load({ filters: { stalled: onlyStalled } }); } },
  }, '只看卡住的任务');

  function syncToggle() {
    stalledToggle.classList.toggle('is-on', onlyStalled);
    stalledToggle.setAttribute('aria-pressed', String(onlyStalled));
  }

  const root = el('div', { class: 'page queue' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, '处理队列'),
      el('p', { class: 'page__subtitle' }, '每个视频一张卡片,显示最新一次处理任务。'),
      el('div', { class: 'page__actions' },
        stalledToggle,
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => list.load() } }, '刷新'),
      ),
    ),
    summarySlot,
    listSlot,
    pagerSlot,
  );

  // The summary bar is not a property of a *page* of results: 排队中/处理中/失败
  // describe the whole queue, so the endpoint sends them next to `rows`. The
  // list controller tracks only rows and total, so they are kept here and
  // updated by both the page fetch and the poll — otherwise the bar would read
  // zero until the first poll tick, eight seconds after the page settles.
  let counts = {};

  const list = createListController({
    pageSize: 20,
    fetchPage: async ({ page, pageSize }) => {
      const result = await jobs.list({ page, pageSize, stalled: onlyStalled });
      counts = result.counts ?? counts;
      return result;
    },
    onChange: paint,
  });

  function paint({ loading, rows, total, error, page }) {
    if (error) {
      mount(listSlot, errorState({ message: describeError(error), onRetry: () => list.load() }));
      mount(summarySlot);
      mount(pagerSlot);
      return;
    }
    renderSummary(rows);
    if (loading) {
      mount(listSlot, el('div', { class: 'skeleton skeleton--rows' }));
      return;
    }
    if (!rows.length) {
      mount(listSlot, emptyState({
        title: onlyStalled ? '没有卡住的任务' : '处理队列是空的',
        hint: onlyStalled ? '所有任务都在正常推进。' : '上传原片后任务会出现在这里。',
      }));
      mount(pagerSlot);
      return;
    }
    mount(listSlot, ...rows.map(card));
    if (total > list.pageSize) {
      const pager = pagination({ page, pageSize: list.pageSize, total, onChange: (next) => list.load({ page: next }) });
      mount(pagerSlot, pager.root);
    } else {
      mount(pagerSlot);
    }
  }

  function renderSummary(rows) {
    const stalled = (rows ?? []).filter((row) => row.stalled).length;
    mount(summarySlot, el('div', { class: 'stat-row' },
      stat('排队中', counts?.WAITING ?? 0),
      stat('处理中', counts?.RUNNING ?? 0),
      stat('失败', counts?.FAILED ?? 0),
      stat('疑似卡住', stalled, stalled > 0 ? 'is-danger' : null),
    ));
  }

  function stat(label, value, tone) {
    return el('div', { class: `stat${tone ? ` ${tone}` : ''}` },
      el('span', { class: 'stat__value' }, String(value)),
      el('span', { class: 'stat__label' }, label),
    );
  }

  function card(row) {
    const job = row.job;
    const canRetry = row.stalled || job?.state === 'FAILED' || !job;
    const canCancel = job && ['WAITING', 'RUNNING'].includes(job.state);

    return el('article', { class: `queue-card${row.stalled ? ' is-stalled' : ''}` },
      el('header', { class: 'queue-card__head' },
        el('div', { class: 'queue-card__title-wrap' },
          el('h2', { class: 'queue-card__title' }, row.title || '未命名'),
          el('div', { class: 'queue-card__badges' },
            statusBadge(row.status),
            jobBadge(job?.state, { stalled: row.stalled }),
            job?.stage ? el('span', { class: 'chip chip--muted' }, stageLabel(job.stage)) : null,
          ),
        ),
        el('div', { class: 'queue-card__actions' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            on: { click: () => navigate(`/admin/videos?focus=${row.id}`) },
          }, '查看视频'),
          canRetry ? el('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            on: { click: () => retry(row) },
          }, '重试') : null,
          canCancel ? el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            on: { click: () => cancel(row) },
          }, '取消') : null,
        ),
      ),
      job
        ? el('div', { class: 'queue-card__body' },
            progressBar(job.progress ?? 0, { label: `${job.progress ?? 0}%` }),
            el('dl', { class: 'queue-card__meta' },
              el('div', null, el('dt', null, '尝试次数'), el('dd', null, String(job.attempt_count ?? 0))),
              job.automatic_recovery_count ? el('div', null, el('dt', null, '自动恢复'), el('dd', null, String(job.automatic_recovery_count))) : null,
              job.lease_until ? el('div', null, el('dt', null, '租约至'), el('dd', null, formatTime(job.lease_until))) : null,
              job.updated_at ? el('div', null, el('dt', null, '最近更新'), el('dd', null, formatTime(job.updated_at))) : null,
            ),
            job.error_message || job.error_code
              ? el('p', { class: 'queue-card__error' }, job.error_message || job.error_code)
              : null,
          )
        : el('p', { class: 'queue-card__empty' }, '该视频还没有处理任务,可以上传原片开始处理。'),
    );
  }

  async function retry(row) {
    if (!row.job?.id) {
      toast('该视频还没有任务记录,请先上传原片。', { variant: 'warn' });
      return;
    }
    const ok = await confirm({
      title: '重试处理',
      message: `将重新排队处理「${row.title || '未命名'}」,已完成的步骤不会重复执行。`,
      confirmLabel: '重试',
    });
    if (!ok) return;
    try {
      await jobs.retry(row.job.id, { videoId: row.id });
      toast('已重新排队', { variant: 'success' });
      await list.load();
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }

  async function cancel(row) {
    const ok = await confirm({
      title: '取消处理',
      message: `确定取消「${row.title || '未命名'}」当前的处理任务吗?`,
      confirmLabel: '取消任务',
      danger: true,
    });
    if (!ok) return;
    try {
      await jobs.cancel(row.job.id);
      toast('已取消', { variant: 'success' });
      await list.load();
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }

  const stopPolling = jobs.startPolling((result) => {
    // `result.page`, not `1`: the poll repeats whatever page the operator is
    // on. Hardcoding it here is what used to yank them back to page 1 mid-read.
    if (!result.rows) return;
    paint({
      loading: false,
      rows: result.rows,
      total: result.total ?? result.rows.length,
      page: result.page ?? 1,
      counts: result.counts,
    });
  });

  return {
    root,
    async mount() { await list.load(); },
    unmount() { stopPolling(); },
  };
}

function stageLabel(stage) {
  return {
    DOWNLOAD: '拉取原片',
    PROBE: '读取元信息',
    TRANSCODE: '转码',
    TRANSCRIBE: '语音识别',
    TRANSLATE: '翻译',
    TTS: '语音合成',
    PACKAGE: '打包',
    PUBLISH: '发布',
  }[stage] || stage;
}

function formatTime(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
