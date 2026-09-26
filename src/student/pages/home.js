/* Eastudy V3 — 学员首页 (M02).

   What the legacy home got wrong: it opened with four carousels of
   recommendations the product decision removed (热门标签/热门合集/推荐博主/
   推荐视频). Those are gone by design, not by omission.

   What replaces them is the thing a returning learner actually wants: the one
   video they were in the middle of, then the newest published videos. */

import { el, mount } from '../../core/dom.js';
import { emptyState, errorState, statusBadge } from '../../ui/index.js';
import { createListController } from '../../ui/table.js';
import { describeError } from '../../services/index.js';
import { summarize, summaryLine } from '../summary.js';

export function createHomePage({ catalog, progress, navigate, session }) {
  const continueSlot = el('section', { class: 'home__continue' });
  /* 概览条:一句话说清"今天/这周动过没有". 它排在主卡上面,因为它比主卡更
     快地回答问题 —— 主卡要等 progress 和 catalog 两次请求,而这一条只用
     progress 一次. 空的时候整条不画,不占位置也不显示"0 个". */
  const summarySlot = el('section', { class: 'home__summary' });
  const grid = el('div', { class: 'card-grid' });
  const pagerSlot = el('div', { class: 'home__pager' });
  const listSlot = el('section', { class: 'home__list' });

  const root = el('div', { class: 'page home' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, greeting(session?.profile?.display_name)),
      el('p', { class: 'page__subtitle' }, '继续未完成的课程,或浏览最新上线的视频。'),
    ),
    summarySlot,
    continueSlot,
    listSlot,
    pagerSlot,
  );

  function greeting(name) {
    const hour = Number(new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date()));
    const part = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
    return name ? `${part},${name}` : part;
  }

  const list = createListController({
    pageSize: 24,
    fetchPage: ({ page, pageSize, query }) => catalog.list({ page, pageSize, q: query }),
    onChange: ({ loading, rows, total, error, page }) => paint({ loading, rows, total, error, page }),
  });

  function paint({ loading, rows, total, error, page }) {
    if (error) {
      mount(grid, errorState({ message: describeError(error), onRetry: () => list.load() }));
      return;
    }
    if (loading) {
      mount(grid, ...Array.from({ length: 8 }, () => el('div', { class: 'card card--skeleton' })));
      return;
    }
    if (!rows.length) {
      mount(grid, emptyState({
        title: '还没有已上线的视频',
        hint: '视频通过审核并发布后会出现在这里。',
        action: el('button', { class: 'btn btn--ghost', type: 'button', on: { click: () => navigate('/search') } }, '去搜索'),
      }));
      return;
    }
    mount(grid, ...rows.map(card));
    renderPager(page, total);
  }

  function renderPager(page, total) {
    const pages = Math.max(1, Math.ceil(total / list.pageSize));
    if (pages <= 1) { mount(pagerSlot); return; }
    mount(pagerSlot, el('div', { class: 'pager' },
      el('button', {
        class: 'pager__btn', type: 'button', disabled: page <= 1 || undefined,
        on: { click: () => list.load({ page: page - 1 }) },
      }, '上一页'),
      el('span', { class: 'pager__total' }, `第 ${page} / ${pages} 页`),
      el('button', {
        class: 'pager__btn', type: 'button', disabled: page >= pages || undefined,
        on: { click: () => list.load({ page: page + 1 }) },
      }, '下一页'),
    ));
  }

  function card(video) {
    const poster = video.cover_url
      ? el('img', { class: 'card__cover', src: video.cover_url, alt: '', loading: 'lazy', decoding: 'async' })
      : el('div', { class: 'card__cover card__cover--empty' }, '暂无封面');

    const row = progress.get(video.id);
    const pct = row?.coverage ? Math.round(row.coverage * 100) : 0;

    return el('article', { class: 'card card--video' },
      el('a', {
        class: 'card__link', href: `#/watch/${encodeURIComponent(video.id)}`,
        on: { click: (event) => { event.preventDefault(); navigate(`/watch/${video.id}`); } },
      },
        poster,
        el('div', { class: 'card__body' },
          el('h3', { class: 'card__title' }, video.title || '未命名'),
          video.subtitle ? el('p', { class: 'card__subtitle' }, video.subtitle) : null,
          el('div', { class: 'card__meta' },
            video.level ? el('span', { class: 'chip' }, video.level) : null,
            video.duration_seconds ? el('span', { class: 'card__duration' }, formatDuration(video.duration_seconds)) : null,
            row?.completed ? statusBadge('PUBLISHED') && el('span', { class: 'chip chip--ok' }, '已完成') : null,
          ),
          pct > 0 && !row?.completed
            ? el('div', { class: 'card__progress' }, el('div', { class: 'card__progress-fill', style: { width: `${pct}%` } }))
            : null,
        ),
      ),
    );
  }

  /** 概览条。数字全部来自已有的进度行,不额外发请求。 */
  function renderSummary() {
    const stats = summarize(progress.rows);
    // 一条进度都没有时不画 —— 新用户看到"这周还没开始"只会觉得被催,
    // 而他其实还没开始用,那句话对他没有信息量。
    if (!stats.hasAny) { mount(summarySlot); return; }
    // 文案由 summary.js 统一给出,并在 tests/unit/summary.test.mjs 里覆盖到
    // "零完成不显示"这类细节 —— 在页面里再手拼一遍就等于有了第二份文案,
    // 两份迟早会不一致。
    mount(summarySlot, el('p', { class: 'home__summary-line' }, summaryLine(stats)));
  }

  /* 三张等宽卡片的旧布局把"最近那一个"和"另外两个"摆成了同一档，
     而首页上真正有信息量的只有最近那一个。这里把第一张提成主卡，
     剩下两张降级成一行小入口 —— 决策成本从"选一个"降到"点下去"。 */
  async function renderContinue() {
    const rows = progress.rows
      .filter((row) => !row.completed && (row.position_seconds || 0) > 5)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    if (!rows.length) { mount(continueSlot); return; }

    // 主卡先解析：它决定这一整段要不要画，不该等三次 detail() 才知道结果。
    const [head, ...rest] = rows;
    const hero = await catalog.detail(head.video_id).catch(() => null);
    if (!hero) { mount(continueSlot); return; }

    const behind = await Promise.all(rest.slice(0, 2).map((row) =>
      catalog.detail(row.video_id).then((video) => ({ row, video })).catch(() => null)));

    mount(continueSlot,
      el('a', {
        class: 'resume', href: `#/watch/${encodeURIComponent(head.video_id)}`,
        on: { click: (event) => { event.preventDefault(); navigate(`/watch/${head.video_id}`); } },
      },
        el('div', { class: 'resume__thumb' },
          hero.cover_url
            ? el('img', { class: 'resume__cover', src: hero.cover_url, alt: '', decoding: 'async' })
            : el('div', { class: 'resume__cover resume__cover--empty' }, '暂无封面'),
          el('span', { class: 'resume__play', 'aria-hidden': 'true' }),
        ),
        el('div', { class: 'resume__body' },
          el('p', { class: 'resume__eyebrow' }, '继续学习'),
          el('h2', { class: 'resume__title' }, hero.title || '未命名'),
          el('p', { class: 'resume__meta' },
            `已学 ${percent(head)}% · 上次看到 ${formatDuration(head.position_seconds || 0)}`),
          el('div', { class: 'resume__bar' },
            el('div', { class: 'resume__bar-fill', style: { width: `${percent(head)}%` } })),
          el('span', { class: 'resume__cta' }, '继续播放'),
        ),
      ),
      behind.filter(Boolean).length
        ? el('div', { class: 'resume-row' }, ...behind.filter(Boolean).map(({ row, video }) =>
            el('a', {
              class: 'resume-mini', href: `#/watch/${encodeURIComponent(video.id)}`,
              on: { click: (event) => { event.preventDefault(); navigate(`/watch/${video.id}`); } },
            },
              el('span', { class: 'resume-mini__title' }, video.title || '未命名'),
              el('span', { class: 'resume-mini__meta' }, `已学 ${percent(row)}%`),
            )))
        : null,
    );
  }

  return {
    root,
    async mount() {
      // Both fetches are independent; a slow progress read must not hold up
      // the catalog, and a failed progress read must not blank the page.
      progress.fetchAll().then(() => { renderSummary(); renderContinue(); }).catch(() => {});
      await list.load();
    },
    unmount() {},
  };
}

/** Coverage arrives as a 0–1 fraction and is absent on rows that predate the
    column, so it needs both a null guard and a clamp — a row with a corrupt
    value above 1 would otherwise push the bar past its track. */
function percent(row) {
  const value = Math.round((row?.coverage || 0) * 100);
  return Math.min(100, Math.max(0, value));
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
