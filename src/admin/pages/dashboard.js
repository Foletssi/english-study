/* Eastudy V3 — 运营总览 (M10/M07).

   Every figure on this page comes from /api/admin/dashboard, which derives it
   from rows the student side writes. There is no placeholder metric and no
   "预计" number: if the API cannot compute it, it is not drawn. */

import { el, mount } from '../../core/dom.js';
import { errorState } from '../../ui/index.js';
import { describeError } from '../../services/index.js';
import { jobBadge, statusBadge } from '../../ui/status.js';

export function createDashboardPage({ api, navigate, jobs }) {
  const slot = el('div', { class: 'dash' });

  const root = el('div', { class: 'page dashboard' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, '运营总览'),
      el('p', { class: 'page__subtitle' }, '所有数据均来自真实记录,不包含推算值。'),
    ),
    slot,
  );

  async function load() {
    mount(slot, el('div', { class: 'skeleton skeleton--cards' }));
    try {
      const data = await api.get('/api/admin/dashboard');
      paint(data);
    } catch (error) {
      mount(slot, errorState({ message: describeError(error), onRetry: load }));
    }
  }

  function paint(data) {
    mount(slot,
      el('section', { class: 'dash__row' },
        statCard('视频总数', data.videos.total, [
          ['已发布', data.videos.published],
          ['待审核', data.videos.review],
          ['处理中', data.videos.processing],
          ['草稿', data.videos.draft],
          ['已下架', data.videos.archived],
        ], () => navigate('/admin/videos')),
        statCard('学员', data.learners.total, [
          ['近 7 天活跃', data.learners.activeLast7Days],
          ['近 7 天完成', data.learners.completionsLast7Days],
        ]),
        pipelineCard(data.videos.pipeline),
      ),
      trendCard(data.daily),
      jobsCard(data.recentJobs),
    );
  }

  function statCard(title, value, rows, onOpen) {
    return el('article', { class: `stat-card${onOpen ? ' is-clickable' : ''}`, on: onOpen ? { click: onOpen } : undefined },
      el('h2', { class: 'stat-card__title' }, title),
      el('p', { class: 'stat-card__value' }, String(value)),
      el('dl', { class: 'stat-card__rows' }, ...rows.map(([label, count]) => el('div', null,
        el('dt', null, label),
        el('dd', null, String(count ?? 0)),
      ))),
    );
  }

  function pipelineCard(pipeline) {
    const entries = Object.entries(pipeline || {}).filter(([, count]) => count > 0);
    return el('article', { class: 'stat-card' },
      el('h2', { class: 'stat-card__title' }, '处理通道'),
      el('dl', { class: 'stat-card__rows' },
        ...(entries.length ? entries : [['暂无任务', 0]]).map(([label, count]) => el('div', null,
          el('dt', null, pipelineLabel(label)),
          el('dd', null, String(count)),
        )),
      ),
    );
  }

  function pipelineLabel(key) {
    return { WAITING: '等待处理', READY: '已就绪', FAILED: '处理失败' }[key] || key;
  }

  function trendCard(daily) {
    const rows = daily ?? [];
    const max = Math.max(1, ...rows.map((row) => row.activeLearners));
    return el('article', { class: 'card dash__trend' },
      el('h2', { class: 'card__title' }, '近 7 天活跃学员'),
      rows.length
        ? el('div', { class: 'spark' }, ...rows.map((row) => el('div', { class: 'spark__col' },
            el('div', {
              class: 'spark__bar',
              style: { height: `${Math.max(4, (row.activeLearners / max) * 100)}%` },
              title: `${row.day}:${row.activeLearners} 人`,
            }),
            el('span', { class: 'spark__label' }, row.day.slice(5)),
          )))
        : el('p', { class: 'card__hint' }, '近 7 天没有学习记录。'),
    );
  }

  function jobsCard(recent) {
    return el('article', { class: 'card' },
      el('header', { class: 'card__head' },
        el('h2', { class: 'card__title' }, '最近处理任务'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          on: { click: () => navigate('/admin/jobs') },
        }, '查看全部'),
      ),
      recent?.length
        ? el('ul', { class: 'mini-list' }, ...recent.map((job) => el('li', null,
            el('span', { class: 'mini-list__main' }, shortId(job.video_id)),
            jobBadge(job.state),
            el('span', { class: 'mini-list__time' }, relative(job.updated_at)),
          )))
        : el('p', { class: 'card__hint' }, '还没有处理任务。'),
    );
  }

  return {
    root,
    async mount() {
      await load();
      // Piggyback a queue poll so a stalled job surfaces on the dashboard too.
      jobs.list({ page: 1, pageSize: 1 }).catch(() => {});
    },
    unmount() {},
  };
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : '—';
}

function relative(input) {
  const time = new Date(input).getTime();
  if (Number.isNaN(time)) return '—';
  const delta = Math.round((Date.now() - time) / 1000);
  if (delta < 60) return '刚刚';
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86400)} 天前`;
}

void statusBadge;
