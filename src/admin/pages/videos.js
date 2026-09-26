/* Eastudy V3 — 视频管理 (M07).

   The list is the operator's home base: create, edit, move through the state
   machine, upload a source, publish, and soft-delete. Every mutation carries
   the row's `revision`, and a 409 means someone else saved first — the page
   then shows the current row rather than silently overwriting it. */

import { el, mount, setText } from '../../core/dom.js';
import { createTable, createListController, emptyState, errorState, pagination, toast } from '../../ui/index.js';
import { confirm, openModal } from '../../ui/modal.js';
import { textField, textAreaField, selectField, formGrid } from '../../ui/field.js';
import { statusBadge, pipelineBadge } from '../../ui/status.js';
import { describeError } from '../../services/index.js';
import { createUploadFlow } from '../upload-flow.js';

const STATUS_FILTERS = [
  { value: '', label: '全部状态' },
  { value: 'DRAFT', label: '草稿' },
  { value: 'PROCESSING', label: '处理中' },
  { value: 'REVIEW', label: '待审核' },
  { value: 'PUBLISHED', label: '已发布' },
  { value: 'ARCHIVED', label: '已下架' },
];

export function createVideosPage({ videos: videosService, catalog, navigate }) {
  let status = '';
  let query = '';

  const searchInput = el('input', {
    class: 'input input--search',
    type: 'search',
    placeholder: '搜索标题',
    'aria-label': '搜索视频',
  });
  const statusSelect = el('select', { class: 'input input--compact', 'aria-label': '状态' },
    ...STATUS_FILTERS.map((item) => el('option', { value: item.value }, item.label)));

  const createButton = el('button', {
    class: 'btn btn--primary', type: 'button',
    on: { click: () => openCreate() },
  }, '新建视频');

  const tableSlot = el('div', { class: 'table-wrap' });
  const pagerSlot = el('div');

  const root = el('div', { class: 'page admin-videos' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, '视频管理'),
      el('p', { class: 'page__subtitle' }, '创建、处理、审核并发布课程视频。'),
      el('div', { class: 'page__actions' }, createButton),
    ),
    el('div', { class: 'toolbar' }, searchInput, statusSelect),
    tableSlot,
    pagerSlot,
  );

  const table = createTable({
    rowKey: (row) => row.id,
    columns: [
      { key: 'title', label: '标题', render: (row) => el('div', { class: 'cell-title' },
          el('span', { class: 'cell-title__main' }, row.title || '未命名'),
          row.subtitle ? el('span', { class: 'cell-title__sub' }, row.subtitle) : null,
        ) },
      { key: 'status', label: '状态', width: '110px', render: (row) => el('div', { class: 'cell-badges' },
          statusBadge(row.status),
          row.status === 'PROCESSING' || row.status === 'REVIEW' ? pipelineBadge(row.pipeline_status) : null,
        ) },
      { key: 'category', label: '分类', width: '110px' },
      { key: 'level', label: '难度', width: '90px' },
      { key: 'revision', label: '版本', width: '70px', align: 'right', render: (row) => `r${row.revision ?? 1}` },
      { key: 'updated_at', label: '更新时间', width: '150px', render: (row) => relative(row.updated_at) },
      { key: 'ops', label: '操作', width: '210px', align: 'right', render: (row) => el('div', { class: 'row-actions' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            on: { click: (event) => { event.stopPropagation(); openEdit(row); } },
          }, '编辑'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            on: { click: (event) => { event.stopPropagation(); openUpload(row); } },
          }, '上传原片'),
          row.status === 'REVIEW'
            ? el('button', {
                class: 'btn btn--primary btn--sm', type: 'button',
                on: { click: (event) => { event.stopPropagation(); publish(row); } },
              }, '发布')
            : null,
          row.status !== 'ARCHIVED'
            ? el('button', {
                class: 'btn btn--ghost btn--sm', type: 'button',
                on: { click: (event) => { event.stopPropagation(); archive(row); } },
              }, '下架')
            : null,
        ) },
    ],
  });

  const list = createListController({
    pageSize: 20,
    fetchPage: ({ page, pageSize }) => videosService.list({ page, pageSize, status, q: query }),
    onChange: paint,
  });

  function paint({ loading, rows, total, error, page }) {
    if (error) {
      mount(tableSlot, errorState({ message: describeError(error), onRetry: () => list.load() }));
      mount(pagerSlot);
      return;
    }
    table.render(rows);
    mount(tableSlot, table.root);
    if (!loading && !rows.length) {
      mount(tableSlot, emptyState({
        title: status || query ? '没有匹配的视频' : '还没有视频',
        hint: status || query ? '换一个筛选条件。' : '点击右上角新建第一个视频。',
        action: el('button', { class: 'btn btn--primary', type: 'button', on: { click: () => openCreate() } }, '新建视频'),
      }));
      mount(pagerSlot);
      return;
    }
    if (!loading && total > list.pageSize) {
      const pager = pagination({ page, pageSize: list.pageSize, total, onChange: (next) => list.load({ page: next }) });
      mount(pagerSlot, pager.root);
    } else {
      mount(pagerSlot);
    }
  }

  let debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { query = searchInput.value.trim(); list.load({ query, filters: { status } }); }, 350);
  });
  statusSelect.addEventListener('change', () => {
    status = statusSelect.value;
    list.load({ filters: { status } });
  });

  function openCreate() {
    const title = textField({ name: 'v-title', label: '标题', required: true, autofocus: true });
    const subtitle = textField({ name: 'v-subtitle', label: '副标题' });
    const category = textField({ name: 'v-category', label: '分类', placeholder: '例如:语法' });
    const level = selectField({
      name: 'v-level', label: '难度', value: '初级',
      options: ['入门', '初级', '中级', '高级'].map((value) => ({ value, label: value })),
    });
    const description = textAreaField({ name: 'v-desc', label: '简介' });

    openModal({
      title: '新建视频',
      size: 'lg',
      body: formGrid(title.root, subtitle.root, category.root, level.root, description.root),
      actions: [
        { label: '取消' },
        {
          label: '创建',
          variant: 'primary',
          run: async () => {
            if (!title.value) { title.setError('请填写标题'); return false; }
            try {
              const result = await videosService.create({
                title: title.value,
                subtitle: subtitle.value || null,
                category: category.value || null,
                level: level.value,
                description: description.value || null,
              });
              toast('视频已创建,下一步上传原片。', { variant: 'success' });
              await list.load({ page: 1 });
              if (result?.video) openUpload(result.video);
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

  function openEdit(row) {
    const title = textField({ name: 'v-title', label: '标题', value: row.title || '', required: true, autofocus: true });
    const subtitle = textField({ name: 'v-subtitle', label: '副标题', value: row.subtitle || '' });
    const category = textField({ name: 'v-category', label: '分类', value: row.category || '' });
    const level = selectField({
      name: 'v-level', label: '难度', value: row.level || '初级',
      options: ['入门', '初级', '中级', '高级'].map((value) => ({ value, label: value })),
    });
    const description = textAreaField({ name: 'v-desc', label: '简介', value: row.description || '' });

    openModal({
      title: '编辑视频',
      size: 'lg',
      body: el('div', null,
        formGrid(title.root, subtitle.root, category.root, level.root, description.root),
        el('p', { class: 'field__hint' }, `当前版本 r${row.revision ?? 1}。若其他管理员已保存,本次修改会被拒绝并提示重新载入。`),
      ),
      actions: [
        { label: '取消' },
        {
          label: '保存',
          variant: 'primary',
          run: async () => {
            if (!title.value) { title.setError('请填写标题'); return false; }
            try {
              await videosService.update(row.id, {
                title: title.value,
                subtitle: subtitle.value || null,
                category: category.value || null,
                level: level.value,
                description: description.value || null,
              }, row.revision ?? 1);
              toast('已保存', { variant: 'success' });
              await list.load();
              return true;
            } catch (error) {
              if (error?.status === 409) {
                toast('该视频已被其他人修改,已为你刷新列表。', { variant: 'warn' });
                await list.load();
                return true;
              }
              title.setError(describeError(error));
              return false;
            }
          },
        },
      ],
    });
  }

  function openUpload(row) {
    const flow = createUploadFlow({ video: row, onDone: () => list.load() });
    openModal({
      title: `上传原片 · ${row.title || '未命名'}`,
      size: 'lg',
      body: flow.root,
      dismissible: true,
      onClose: () => flow.dispose(),
    });
  }

  async function publish(row) {
    if (!row.playback_prefix) {
      toast('该视频还没有处理完成,无法发布。', { variant: 'warn' });
      return;
    }
    try {
      await videosService.publish(row.id, row.revision ?? 1);
      toast('已发布', { variant: 'success' });
      await list.load();
    } catch (error) {
      if (error?.status === 409) { toast('状态已变化,请重试。', { variant: 'warn' }); await list.load(); return; }
      toast(describeError(error), { variant: 'error' });
    }
  }

  async function archive(row) {
    const ok = await confirm({
      title: '下架视频',
      message: `下架后学员端将无法再看到「${row.title || '未命名'}」。可以随时重新发布。`,
      confirmLabel: '下架',
      danger: true,
    });
    if (!ok) return;
    try {
      await videosService.archive(row.id, row.revision ?? 1);
      toast('已下架', { variant: 'success' });
      await list.load();
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }

  void setText;
  void catalog;
  void navigate;

  return {
    root,
    async mount() { await list.load(); },
    unmount() { clearTimeout(debounce); },
  };
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
