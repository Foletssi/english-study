/* Eastudy V3 — 生词本与关注 (M06).

   Two tabs over one dataset. Each word keeps the sentence it was met in and a
   deep link back to that moment in the video, which is the whole point of
   collecting it: a bare word list with no context is a dictionary, not a
   study tool. */

import { el, mount, setText } from '../../core/dom.js';
import { emptyState, errorState, toast } from '../../ui/index.js';
import { confirm } from '../../ui/modal.js';
import { describeError } from '../../services/index.js';

const TABS = [
  { key: 'words', label: '生词本' },
  { key: 'following', label: '关注' },
];

export function createVocabularyPage({ vocabulary, progress, navigate, params }) {
  let tab = params?.tab === 'following' ? 'following' : 'words';
  const listSlot = el('div', { class: 'vocab__list' });
  const tabsSlot = el('div', { class: 'tabs', role: 'tablist' });

  const root = el('div', { class: 'page vocab' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, '我的词汇'),
      el('p', { class: 'page__subtitle' }, '收藏的生词会连同出现的那句话一起保存。'),
    ),
    tabsSlot,
    listSlot,
  );

  function renderTabs(counts) {
    mount(tabsSlot, ...TABS.map((item) => el('button', {
      class: `tab${item.key === tab ? ' is-active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(item.key === tab),
      on: { click: () => { tab = item.key; renderTabs(counts); render(); } },
    }, `${item.label}${counts[item.key] ? `(${counts[item.key]})` : ''}`)));
  }

  function render() {
    const data = vocabulary.data;
    const rows = (data?.[tab] ?? []);
    if (!rows.length) {
      mount(listSlot, emptyState({
        title: tab === 'words' ? '生词本还是空的' : '还没有关注任何词',
        hint: '在视频里点击字幕中的单词即可加入。',
        action: el('button', { class: 'btn btn--ghost', type: 'button', on: { click: () => navigate('/catalog') } }, '去看视频'),
      }));
      return;
    }
    mount(listSlot, el('ul', { class: 'vocab-list' }, ...rows.map(rowItem)));
  }

  function rowItem(row) {
    return el('li', { class: 'vocab-item' },
      el('div', { class: 'vocab-item__main' },
        el('div', { class: 'vocab-item__head' },
          el('span', { class: 'vocab-item__word' }, row.surface || row.term),
          row.gloss ? el('span', { class: 'vocab-item__gloss' }, row.gloss) : null,
        ),
        row.source_sentence
          ? el('p', { class: 'vocab-item__sentence' }, row.source_sentence)
          : null,
      ),
      el('div', { class: 'vocab-item__actions' },
        row.source_video_id
          ? el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              on: { click: () => navigate(`/watch/${row.source_video_id}${row.source_start_seconds ? `?t=${Math.floor(row.source_start_seconds)}` : ''}`) },
            }, '回到原句')
          : null,
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          on: { click: () => remove(row) },
        }, '移除'),
      ),
    );
  }

  async function remove(row) {
    const ok = await confirm({
      title: '移除',
      message: `确定移除「${row.surface || row.term}」吗?`,
      confirmLabel: '移除',
      danger: true,
    });
    if (!ok) return;
    try {
      await vocabulary.remove(row.id);
      toast('已移除', { variant: 'success' });
      await load();
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }

  async function load() {
    mount(listSlot, el('div', { class: 'skeleton skeleton--rows' }));
    try {
      const data = await vocabulary.load();
      renderTabs({ words: data.words?.length ?? 0, following: data.following?.length ?? 0 });
      render();
    } catch (error) {
      mount(listSlot, errorState({ message: describeError(error), onRetry: load }));
    }
  }

  return {
    root,
    async mount() { await load(); },
    unmount() {},
  };
}
