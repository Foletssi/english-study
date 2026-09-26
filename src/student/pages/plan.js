/* Eastudy V3 — 学习计划与进度 (M05).

   A plan is a named, ordered list of videos with a target date. The legacy had
   a plan feature that could not be edited after creation and showed progress
   as "3/10 已完成" computed from the furthest position, which disagreed with
   the completion rule everywhere else in the product. Both fixed here: the
   same coverage ≥ 90% rule is used, and the count comes from the same rows the
   dashboard reads. */

import { el, mount, setText } from '../../core/dom.js';
import { createListController, emptyState, errorState, progressBar } from '../../ui/index.js';
import { confirm, openModal } from '../../ui/modal.js';
import { textField, formGrid } from '../../ui/field.js';
import { describeError } from '../../services/index.js';
import { toast } from '../../ui/toast.js';

export function createPlanPage({ api, catalog, progress, navigate }) {
  const listSlot = el('div', { class: 'plan__list' });

  const createButton = el('button', { class: 'btn btn--primary', type: 'button', on: { click: openCreate } }, '新建计划');

  const root = el('div', { class: 'page plan' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, '学习计划'),
      el('p', { class: 'page__subtitle' }, '把要学的视频排成顺序,按计划推进。'),
      el('div', { class: 'page__actions' }, createButton),
    ),
    listSlot,
  );

  const list = createListController({
    pageSize: 20,
    fetchPage: ({ page, pageSize }) => api.get('/api/plans', { query: { page, pageSize } }),
    onChange: paint,
  });

  function paint({ loading, rows, error }) {
    if (error) {
      mount(listSlot, errorState({ message: describeError(error), onRetry: () => list.load() }));
      return;
    }
    if (loading) {
      mount(listSlot, el('div', { class: 'skeleton skeleton--rows' }));
      return;
    }
    if (!rows.length) {
      mount(listSlot, emptyState({
        title: '还没有学习计划',
        hint: '新建一个计划,把要学的视频排好顺序。',
        action: el('button', { class: 'btn btn--primary', type: 'button', on: { click: openCreate } }, '新建计划'),
      }));
      return;
    }
    mount(listSlot, ...rows.map(planCard));
  }

  function planCard(plan) {
    const items = plan.items ?? [];
    const done = items.filter((item) => progress.get(item.video_id)?.completed).length;
    const pct = items.length ? (done / items.length) * 100 : 0;

    return el('article', { class: 'plan-card' },
      el('header', { class: 'plan-card__head' },
        el('div', null,
          el('h2', { class: 'plan-card__title' }, plan.title || '未命名计划'),
          plan.target_date ? el('p', { class: 'plan-card__date' }, `目标日期 ${plan.target_date}`) : null,
        ),
        el('div', { class: 'plan-card__actions' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            on: { click: () => openEdit(plan) },
          }, '编辑'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            on: { click: () => removePlan(plan) },
          }, '删除'),
        ),
      ),
      progressBar(pct, { label: `${done} / ${items.length} 已完成` }),
      el('ol', { class: 'plan-card__items' }, ...items.map((item) => {
        const row = progress.get(item.video_id);
        return el('li', { class: `plan-item${row?.completed ? ' is-done' : ''}` },
          el('button', {
            class: 'plan-item__link', type: 'button',
            on: { click: () => navigate(`/watch/${item.video_id}`) },
          },
            el('span', { class: 'plan-item__title' }, item.title || '(视频已下架)'),
            el('span', { class: 'plan-item__state' }, row?.completed ? '已完成' : row?.coverage ? `${Math.round(row.coverage * 100)}%` : '未开始'),
          ),
        );
      })),
    );
  }

  function openCreate() {
    const title = textField({ name: 'plan-title', label: '计划名称', placeholder: '例如:9 月语法专项', required: true, autofocus: true });
    const target = textField({ name: 'plan-target', label: '目标日期', type: 'date' });

    openModal({
      title: '新建学习计划',
      body: formGrid(title.root, target.root),
      actions: [
        { label: '取消' },
        {
          label: '创建',
          variant: 'primary',
          run: async () => {
            if (!title.value) { title.setError('请填写计划名称'); return false; }
            try {
              await api.post('/api/plans', { title: title.value, target_date: target.value || null }, { retry: false });
              toast('计划已创建', { variant: 'success' });
              await list.load({ page: 1 });
              return true;
            } catch (error) {
              title.setError(describeError(error));
              return false;
            }
          },
        },
      ],
    });
  }

  function openEdit(plan) {
    const title = textField({ name: 'plan-title', label: '计划名称', value: plan.title || '', required: true, autofocus: true });
    const target = textField({ name: 'plan-target', label: '目标日期', type: 'date', value: plan.target_date || '' });
    const picker = el('div', { class: 'plan-picker' });
    let items = [...(plan.items ?? [])];

    function renderPicker() {
      mount(picker,
        el('h3', { class: 'plan-picker__title' }, `视频(${items.length})`),
        items.length
          ? el('ol', { class: 'plan-picker__list' }, ...items.map((item, index) => el('li', null,
              el('span', null, `${index + 1}. ${item.title || item.video_id}`),
              el('button', {
                class: 'btn btn--ghost btn--sm', type: 'button',
                on: { click: () => { items.splice(index, 1); renderPicker(); } },
              }, '移除'),
            )))
          : el('p', { class: 'plan-picker__empty' }, '还没有添加视频。'),
        el('div', { class: 'plan-picker__add' },
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: addVideo } }, '添加视频'),
        ),
      );
    }

    async function addVideo() {
      const search = textField({ name: 'pick-q', label: '搜索视频', autofocus: true });
      const results = el('div', { class: 'plan-picker__results' });
      const pickerModal = openModal({
        title: '添加视频',
        body: el('div', null, search.root, results),
        actions: [{ label: '完成' }],
      });

      const run = async () => {
        try {
          const page = await catalog.list({ page: 1, pageSize: 10, q: search.value, useCache: false });
          mount(results, ...(page.rows ?? []).map((video) => el('button', {
            class: 'plan-picker__result', type: 'button',
            on: {
              click: () => {
                if (!items.some((item) => item.video_id === video.id)) {
                  items.push({ video_id: video.id, title: video.title });
                  renderPicker();
                }
                pickerModal.close('action');
              },
            },
          }, video.title || '未命名')));
        } catch (error) {
          mount(results, el('p', { class: 'field__error' }, describeError(error)));
        }
      };
      search.input.addEventListener('input', debounce(run, 300));
      run();
    }

    renderPicker();

    openModal({
      title: '编辑学习计划',
      size: 'lg',
      body: el('div', null, formGrid(title.root, target.root), picker),
      actions: [
        { label: '取消' },
        {
          label: '保存',
          variant: 'primary',
          run: async () => {
            if (!title.value) { title.setError('请填写计划名称'); return false; }
            try {
              await api.patch(`/api/plans/${plan.id}`, {
                title: title.value,
                target_date: target.value || null,
                video_ids: items.map((item) => item.video_id),
              }, { retry: false });
              toast('计划已更新', { variant: 'success' });
              await list.load();
              return true;
            } catch (error) {
              title.setError(describeError(error));
              return false;
            }
          },
        },
      ],
    });
  }

  async function removePlan(plan) {
    const ok = await confirm({
      title: '删除学习计划',
      message: `确定删除「${plan.title || '未命名计划'}」吗?学习进度不会被删除。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/plans/${plan.id}`, { retry: false });
      toast('计划已删除', { variant: 'success' });
      await list.load();
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }

  return {
    root,
    async mount() { await list.load(); },
    unmount() {},
  };
}

function debounce(fn, ms) {
  let timer = null;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}
