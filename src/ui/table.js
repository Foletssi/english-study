/* Eastudy V3 — table, empty state and pagination.

   These three always travel together (a list is a table or an empty state, and
   a long list is paged), so they live in one module and share one shape:
   `columns` is an array of { key, label, width, align, render(row) }. */

import { el, mount } from '../core/dom.js';

export function createTable({ columns, rows, rowKey = (row) => row.id, onRowClick, loading = false }) {
  const thead = el('thead', null, el('tr', null, ...columns.map((column) => el('th', {
    class: column.align ? `is-${column.align}` : null,
    style: column.width ? { width: column.width } : undefined,
    scope: 'col',
  }, column.label))));

  const tbody = el('tbody');
  const table = el('table', { class: 'table' }, thead, tbody);

  function render(nextRows) {
    rows = nextRows;
    if (loading) {
      mount(tbody, el('tr', null, el('td', { colspan: String(columns.length), class: 'table__loading' }, '加载中…')));
      return;
    }
    if (!rows.length) {
      mount(tbody, el('tr', null, el('td', { colspan: String(columns.length), class: 'table__empty' }, '暂无数据')));
      return;
    }
    mount(tbody, ...rows.map((row) => {
      const tr = el('tr', {
        dataset: { key: String(rowKey(row)) },
        on: onRowClick ? { click: () => onRowClick(row) } : undefined,
      }, ...columns.map((column) => {
        const cell = el('td', { class: column.align ? `is-${column.align}` : null });
        const content = column.render ? column.render(row) : row[column.key];
        if (content instanceof Node) cell.appendChild(content);
        else cell.textContent = content ?? '—';
        return cell;
      }));
      if (onRowClick) tr.classList.add('is-clickable');
      return tr;
    }));
  }

  render(rows);
  return { root: table, render };
}

export function emptyState({ title, hint, action = null, icon = '—' }) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty__icon', 'aria-hidden': 'true' }, icon),
    el('p', { class: 'empty__title' }, title),
    hint ? el('p', { class: 'empty__hint' }, hint) : null,
    action ? el('div', { class: 'empty__action' }, action) : null,
  );
}

export function errorState({ message, onRetry }) {
  return el('div', { class: 'empty empty--error' },
    el('p', { class: 'empty__title' }, '加载失败'),
    el('p', { class: 'empty__hint' }, message || '请稍后重试'),
    onRetry ? el('div', { class: 'empty__action' },
      el('button', { class: 'btn btn--ghost', type: 'button', on: { click: onRetry } }, '重试'),
    ) : null,
  );
}

export function pagination({ page, pageSize, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const root = el('nav', { class: 'pager', 'aria-label': '分页' });

  function render() {
    const buttons = [];
    buttons.push(el('button', {
      class: 'pager__btn', type: 'button', disabled: page <= 1 || undefined,
      on: { click: () => go(page - 1) },
    }, '上一页'));

    for (const p of pageWindow(page, pages)) {
      if (p === '…') { buttons.push(el('span', { class: 'pager__gap' }, '…')); continue; }
      buttons.push(el('button', {
        class: `pager__btn${p === page ? ' is-current' : ''}`,
        type: 'button',
        'aria-current': p === page ? 'page' : undefined,
        on: { click: () => go(p) },
      }, String(p)));
    }

    buttons.push(el('button', {
      class: 'pager__btn', type: 'button', disabled: page >= pages || undefined,
      on: { click: () => go(page + 1) },
    }, '下一页'));

    mount(root,
      ...buttons,
      el('span', { class: 'pager__total' }, `共 ${total} 条`),
    );
  }

  function go(next) {
    if (next < 1 || next > pages || next === page) return;
    page = next;
    render();
    onChange?.(page);
  }

  render();
  return { root, render, get page() { return page; } };
}

function pageWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) out.push('…');
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total - 1) out.push('…');
  out.push(total);
  return out;
}

/** Server-side list helper: keeps page/size/query in one object and notifies
    the caller whenever any of them changes. */
export function createListController({ pageSize = 20, fetchPage, onChange }) {
  let page = 1;
  let query = '';
  let filters = {};
  let last = { rows: [], total: 0 };

  async function load(overrides = {}) {
    if (overrides.page) page = overrides.page;
    if (overrides.query !== undefined) { query = overrides.query; page = 1; }
    if (overrides.filters) { filters = overrides.filters; page = 1; }

    onChange?.({ loading: true, page, query, filters, ...last });
    try {
      const result = await fetchPage({ page, pageSize, query, ...filters });
      last = { rows: result.rows ?? result.items ?? [], total: result.total ?? 0 };
      onChange?.({ loading: false, page, query, filters, ...last });
      return last;
    } catch (error) {
      onChange?.({ loading: false, page, query, filters, error, ...last });
      throw error;
    }
  }

  return { load, get page() { return page; }, get query() { return query; }, get pageSize() { return pageSize; } };
}
