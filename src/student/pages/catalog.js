/* Eastudy V3 — 视频库与搜索 (M03).

   One page, two modes. Search is a filter on the same list rather than a
   separate screen, because the legacy's separate search page had its own
   result card markup that drifted from the catalog card within one release.

   Filters live in the URL hash so a filtered view is shareable and the back
   button works, which it did not in the legacy. */

import { el, mount } from '../../core/dom.js';
import { createListController, emptyState, errorState, pagination } from '../../ui/table.js';
import { createFilterBar } from '../../ui/filter-bar.js';
import { describeError } from '../../services/index.js';

export function createCatalogPage({ catalog, progress, navigate, params }) {
  let filters = {
    q: params?.q || '',
    category: params?.category || '',
    level: params?.level || '',
    duration: params?.duration || '',
    updated: params?.updated || 'latest',
    sort: params?.sort || 'recent',
  };

  const searchInput = el('input', {
    class: 'input input--search',
    type: 'search',
    placeholder: '搜索视频标题或关键词',
    value: filters.q,
    'aria-label': '搜索视频',
  });

  const categorySelect = el('select', { class: 'input input--compact', 'aria-label': '分类' },
    el('option', { value: '' }, '全部分类'));

  const countLabel = el('p', { class: 'catalog__count' });
  const grid = el('div', { class: 'card-grid' });
  const pagerSlot = el('div', { class: 'catalog__pager' });

  /* 三行单选 + 排序交给 createFilterBar。分类仍然留在外面当下拉 —— 它是
     服务端聚合出来的动态列表(带条目数), 数量和名字都会变, 塞进那颗按固定
     数组渲染的筛选条里就得为它开一个"动态选项"的口子, 不值得。 */
  const filterBar = createFilterBar({
    value: { duration: filters.duration, level: filters.level, updated: filters.updated },
    sort: filters.sort,
    onChange: (next) => {
      filters = { ...filters, ...next };
      syncUrl();
      list.load({ filters });
    },
    onSort: (sort) => {
      filters = { ...filters, sort };
      syncUrl();
      list.load({ filters });
    },
  });

  const root = el('div', { class: 'page catalog' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, '视频库'),
      el('p', { class: 'page__subtitle' }, '按时长、难度和更新时间筛选,也可以直接搜索标题。'),
    ),
    el('div', { class: 'catalog__filters' },
      el('div', { class: 'catalog__search' }, searchInput,
        el('button', { class: 'btn btn--primary', type: 'button', on: { click: applySearch } }, '搜索')),
      categorySelect,
    ),
    filterBar.root,
    countLabel,
    grid,
    pagerSlot,
  );

  const list = createListController({
    pageSize: 24,
    fetchPage: ({ page, pageSize }) => catalog.list({ page, pageSize, ...filters }),
    onChange: paint,
  });

  let pager = null;

  function paint({ loading, rows, total, error, page }) {
    if (error) {
      mount(grid, errorState({ message: describeError(error), onRetry: () => list.load() }));
      mount(countLabel);
      mount(pagerSlot);
      return;
    }
    if (loading) {
      mount(grid, ...Array.from({ length: 8 }, () => el('div', { class: 'card card--skeleton' })));
      return;
    }
    countLabel.textContent = total ? `共 ${total} 个视频` : '';
    if (!rows.length) {
      mount(grid, emptyState({
        title: '没有匹配的视频',
        hint: '换一个关键词,或清除筛选条件。',
        action: el('button', { class: 'btn btn--ghost', type: 'button', on: { click: reset } }, '清除筛选'),
      }));
      mount(pagerSlot);
      return;
    }
    mount(grid, ...rows.map(card));
    pager = pagination({
      page,
      pageSize: list.pageSize,
      total,
      onChange: (next) => list.load({ page: next }),
    });
    mount(pagerSlot, pager.root);
  }

  function card(video) {
    const cover = video.cover_url
      ? el('img', { class: 'card__cover', src: video.cover_url, alt: '', loading: 'lazy', decoding: 'async' })
      : el('div', { class: 'card__cover card__cover--empty' }, '暂无封面');
    const row = progress.get(video.id);
    return el('article', { class: 'card card--video' },
      el('a', {
        class: 'card__link',
        href: `#/watch/${encodeURIComponent(video.id)}`,
        on: { click: (event) => { event.preventDefault(); navigate(`/watch/${video.id}`); } },
      },
        cover,
        el('div', { class: 'card__body' },
          el('h3', { class: 'card__title' }, video.title || '未命名'),
          video.subtitle ? el('p', { class: 'card__subtitle' }, video.subtitle) : null,
          el('div', { class: 'card__meta' },
            video.level ? el('span', { class: 'chip' }, video.level) : null,
            video.category ? el('span', { class: 'chip chip--muted' }, video.category) : null,
            row?.completed ? el('span', { class: 'chip chip--ok' }, '已完成') : null,
          ),
        ),
      ),
    );
  }

  function applySearch() {
    filters = { ...filters, q: searchInput.value.trim() };
    syncUrl();
    list.load({ query: filters.q, filters });
  }

  function reset() {
    filters = { q: '', category: '', level: '', duration: '', updated: 'latest', sort: 'recent' };
    searchInput.value = '';
    categorySelect.value = '';
    /* 筛选条自己那份状态也要一起清 —— 只清 URL 和列表的话, 那排胶囊还亮着,
       用户看到的是"条件还在, 结果却全回来了"。 */
    filterBar.reset();
    syncUrl();
    list.load({ query: '', filters });
  }

  function syncUrl() {
    const query = new URLSearchParams();
    /* `updated=latest` 和 `sort=recent` 是默认值, 不写进 URL —— 否则分享出去
       的链接里塞着两个没意义的参数, 而且用户清掉筛选后地址栏看起来还是"筛过"。 */
    for (const [key, value] of Object.entries(filters)) {
      if (!value) continue;
      if (key === 'updated' && value === 'latest') continue;
      if (key === 'sort' && value === 'recent') continue;
      query.set(key, value);
    }
    const suffix = query.toString();
    history.replaceState(null, '', `#/catalog${suffix ? `?${suffix}` : ''}`);
  }

  let debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(applySearch, 350);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { clearTimeout(debounce); applySearch(); }
  });
  categorySelect.addEventListener('change', () => {
    filters = { ...filters, category: categorySelect.value };
    syncUrl();
    list.load({ filters });
  });

  async function loadFacets() {
    try {
      const facets = await catalog.facets();
      /* 分类下拉保留服务端的标签和条目数 —— 这两样是聚合出来的, 前端写死
         一份就会在后台加了分类之后对不上。 */
      mount(categorySelect, el('option', { value: '' }, '全部分类'),
        ...(facets.categories ?? []).map((item) => el('option', {
          value: item.value, selected: item.value === filters.category || undefined,
        }, `${item.label}(${item.count})`)));
    } catch {
      // Facets are a convenience; the catalog still works without them.
    }
  }

  return {
    root,
    async mount() {
      // URL 里带进来的筛选条件要同步到那排胶囊上, 否则刷新之后条件生效了、
      // 界面上却显示"全部"。
      filterBar.set({ duration: filters.duration, level: filters.level, updated: filters.updated });
      await list.load({ filters });
      loadFacets();
    },
    unmount() {
      clearTimeout(debounce);
      /* 筛选条的抽屉会在 document 上挂 keydown、在 window 上挂 resize 兜底,
         页面走了要一起收掉, 否则每进一次视频库就多攒一层监听。 */
      filterBar.dispose();
    },
  };
}
