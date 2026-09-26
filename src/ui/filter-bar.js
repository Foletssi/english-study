/* Eastudy V3 — 筛选条.

   三行单选(时长 / 难度 / 更新时间) 加一个排序下拉。设计稿里这是横排的一整块,
   手机上收起成一颗"筛选"按钮 + 底部抽屉。

   为什么是单选而不是多选: 这四个维度每一个都只有一个"当前值", 而且每个值
   都是**范围**不是标签(「10-20 分钟」本身已经包含 10 和 20)。多选时用户要
   自己算"我勾了 0-10 和 20-40 到底会出来什么", 单选没有这个问题。

   状态全部由外部持有(this.filters), 组件只负责把点到的值和当前值报出去 ——
   它不自己存一份, 否则 URL 和界面会各说各话。 */

import { el, mount } from '../core/dom.js';
import { icon } from './icons.js';

export const DURATION_OPTIONS = Object.freeze([
  { value: '', label: '全部' },
  { value: '0-10', label: '0-10 分钟' },
  { value: '10-20', label: '10-20 分钟' },
  { value: '20-40', label: '20-40 分钟' },
  { value: '40-', label: '40 分钟以上' },
]);

export const LEVEL_OPTIONS = Object.freeze([
  { value: '', label: '全部' },
  { value: 'A1', label: 'A1 入门' },
  { value: 'A2', label: 'A2 基础' },
  { value: 'B1', label: 'B1 进阶' },
  { value: 'B2', label: 'B2 提升' },
  { value: 'C1', label: 'C1 挑战' },
]);

export const UPDATED_OPTIONS = Object.freeze([
  { value: 'latest', label: '最新' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'quarter', label: '近三个月' },
]);

export const SORT_OPTIONS = Object.freeze([
  { value: 'recent', label: '最新发布' },
  { value: 'popular', label: '最多学习' },
  { value: 'duration', label: '时长' },
]);

/* 每个维度一行: 标签 + 一排胶囊。`icon` 只是行首的示意图形, 不带语义 ——
   读屏念"时长"两个字就够了, 再念一遍"时钟图标"是噪音。 */
const ROWS = [
  { key: 'duration', label: '时长', glyph: 'clock', options: DURATION_OPTIONS },
  { key: 'level', label: '难度', glyph: 'bars', options: LEVEL_OPTIONS },
  { key: 'updated', label: '更新时间', glyph: 'calendar', options: UPDATED_OPTIONS },
];

export function createFilterBar({ value = {}, onChange, onSort, sort } = {}) {
  const current = {
    duration: value.duration || '',
    level: value.level || '',
    updated: value.updated || UPDATED_OPTIONS[0].value,
  };
  let sortValue = sort || SORT_OPTIONS[0].value;

  const sheet = el('div', { class: 'filter-sheet', hidden: true });
  const body = el('div', { class: 'filter-bar__body' });
  const rows = new Map();

  const sortSelect = el('select', {
    class: 'filter-bar__sort-select',
    'aria-label': '排序方式',
    on: {
      change: () => {
        sortValue = sortSelect.value;
        onSort?.(sortValue);
      },
    },
  }, ...SORT_OPTIONS.map((option) => el('option', {
    value: option.value,
    selected: option.value === sortValue || undefined,
  }, option.label)));

  const summary = el('span', { class: 'filter-bar__summary' });

  const toggleButton = el('button', {
    class: 'filter-bar__toggle', type: 'button',
    'aria-expanded': 'false',
    on: { click: () => toggleSheet() },
  }, icon('filter', { size: 18 }), el('span', null, '筛选'), summary);

  const root = el('section', { class: 'filter-bar', 'aria-label': '筛选条件' },
    el('div', { class: 'filter-bar__inline' },
      body,
      el('div', { class: 'filter-bar__sort' },
        el('span', { class: 'filter-bar__sort-label' }, icon('sort', { size: 16 }), '排序'),
        sortSelect,
      ),
    ),
    toggleButton,
    sheet,
  );

  function paint() {
    mount(body, ...ROWS.map((row) => {
      const group = el('div', { class: 'filter-row', role: 'radiogroup', 'aria-label': row.label },
        el('span', { class: 'filter-row__label' }, icon(row.glyph, { size: 16 }), el('span', null, `${row.label}:`)),
        el('div', { class: 'filter-row__options' }, ...row.options.map((option) => chip(row, option))),
      );
      rows.set(row.key, group);
      return group;
    }));
    paintSummary();
  }

  function chip(row, option) {
    const active = current[row.key] === option.value;
    return el('button', {
      class: `filter-chip${active ? ' is-active' : ''}`,
      type: 'button',
      role: 'radio',
      'aria-checked': String(active),
      dataset: { key: row.key, value: option.value },
      on: {
        click: () => {
          if (current[row.key] === option.value) return;
          current[row.key] = option.value;
          syncChips();
          paintSummary();
          onChange?.({ ...current });
        },
      },
    }, option.label);
  }

  /* 重建整排比逐个改 class 可靠: 胶囊是按行渲染的, 一行里只会有一个 active,
     但"哪一个是"要跟 current 对齐 —— 重建之后不可能出现两个亮着的。 */
  function syncChips() {
    for (const row of ROWS) {
      const group = rows.get(row.key);
      if (!group) continue;
      for (const node of group.querySelectorAll('.filter-chip')) {
        const active = node.dataset.value === current[row.key];
        node.classList.toggle('is-active', active);
        node.setAttribute('aria-checked', String(active));
      }
    }
  }

  function paintSummary() {
    const parts = [];
    const duration = DURATION_OPTIONS.find((o) => o.value === current.duration);
    if (current.duration) parts.push(duration?.label ?? current.duration);
    if (current.level) parts.push(current.level);
    const updated = UPDATED_OPTIONS.find((o) => o.value === current.updated);
    if (current.updated && current.updated !== 'latest') parts.push(updated?.label ?? '');
    summary.textContent = parts.filter(Boolean).join(' · ');
    root.classList.toggle('is-filtered', parts.length > 0);
  }

  // ---------------------------------------------------------- 底部抽屉

  function toggleSheet() {
    if (sheet.hidden) openSheet(); else closeSheet();
  }

  function openSheet() {
    /* 抽屉里放的是**同一批节点**(把 body 搬进去), 不是渲染第二份 ——
       两份的话点抽屉里那排胶囊要同步上面那排, 而上面那排此刻正被盖住。 */
    mount(sheet,
      el('div', { class: 'filter-sheet__panel', role: 'dialog', 'aria-label': '筛选条件' },
        el('header', { class: 'filter-sheet__head' },
          el('h2', { class: 'filter-sheet__title' }, '筛选'),
          el('button', {
            class: 'filter-sheet__close', type: 'button', 'aria-label': '关闭筛选',
            on: { click: () => closeSheet() },
          }, icon('close', { size: 20 })),
        ),
        el('div', { class: 'filter-sheet__body' }, el('div', { class: 'filter-bar__body filter-bar__body--sheet' })),
        el('footer', { class: 'filter-sheet__foot' },
          el('button', {
            class: 'btn btn--ghost', type: 'button',
            on: { click: () => { reset(); closeSheet(); } },
          }, '清除筛选'),
          el('button', {
            class: 'btn btn--primary', type: 'button',
            on: { click: () => closeSheet() },
          }, '查看结果'),
        ),
      ),
    );
    // 同一批节点搬进抽屉 —— 上面那排此刻被盖住, 搬走不会造成视觉空洞。
    mount(sheet.querySelector('.filter-bar__body'), ...rows.values());
    sheet.hidden = false;
    toggleButton.setAttribute('aria-expanded', 'true');
    document.body.classList.add('is-sheet-open');
    sheet.addEventListener('click', onSheetBackdrop, { once: false });
    document.addEventListener('keydown', onSheetKey);
  }

  function closeSheet() {
    if (sheet.hidden) return;
    // 先搬回原位, 再清空抽屉 —— 反过来的话节点会随着 mount 一起被丢掉。
    const inline = root.querySelector('.filter-bar__body');
    mount(inline, ...rows.values());
    mount(sheet);
    sheet.hidden = true;
    toggleButton.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('is-sheet-open');
    sheet.removeEventListener('click', onSheetBackdrop);
    document.removeEventListener('keydown', onSheetKey);
  }

  function onSheetBackdrop(event) {
    // 只有点在遮罩本身(不是面板里)才关 —— 点面板内部不该把抽屉关掉。
    if (event.target === sheet) closeSheet();
  }

  function onSheetKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); closeSheet(); }
  }

  function reset() {
    current.duration = '';
    current.level = '';
    current.updated = UPDATED_OPTIONS[0].value;
    syncChips();
    paintSummary();
    onChange?.({ ...current });
  }

  paint();

  return {
    root,
    get filters() { return { ...current }; },
    get sort() { return sortValue; },
    /** 外部(URL、清除按钮)改了筛选条件时把界面拉回一致 */
    set(next = {}) {
      current.duration = next.duration ?? current.duration;
      current.level = next.level ?? current.level;
      current.updated = next.updated ?? current.updated;
      syncChips();
      paintSummary();
    },
    reset,
    dispose() {
      closeSheet();
    },
  };
}
