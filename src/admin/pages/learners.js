/* Eastudy V3 — 学员 · VIP · 邀请码 (M09).

   Three related surfaces in one page. The invite-code tab is where the
   operator generates codes and exports them; the learners tab is where VIP is
   granted. VIP is always written as an expiry timestamp, never a boolean, so
   expiry needs no background job. */

import { el, mount, setText } from '../../core/dom.js';
import { createTable, createListController, emptyState, errorState, pagination, toast } from '../../ui/index.js';
import { openModal, confirm } from '../../ui/modal.js';
import { textField, selectField, formGrid } from '../../ui/field.js';
import { badge } from '../../ui/status.js';
import { describeError } from '../../services/index.js';

const TABS = [
  { key: 'learners', label: '学员' },
  { key: 'invites', label: '邀请码' },
];

export function createLearnersPage({ learners, navigate }) {
  let tab = 'learners';
  const tabsSlot = el('div', { class: 'tabs', role: 'tablist' });
  const bodySlot = el('div', { class: 'learners__body' });

  const root = el('div', { class: 'page learners' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, '学员管理'),
      el('p', { class: 'page__subtitle' }, '查看学员学习情况,管理 VIP 与邀请码。'),
    ),
    tabsSlot,
    bodySlot,
  );

  function renderTabs() {
    mount(tabsSlot, ...TABS.map((item) => el('button', {
      class: `tab${item.key === tab ? ' is-active' : ''}`,
      type: 'button', role: 'tab', 'aria-selected': String(item.key === tab),
      on: { click: () => { tab = item.key; renderTabs(); renderTab(); } },
    }, item.label)));
  }

  // ------------------------------------------------------------- 学员

  let learnerCtl = null;

  function learnersTab() {
    const search = el('input', { class: 'input input--search', type: 'search', placeholder: '搜索昵称或手机号', 'aria-label': '搜索学员' });
    const vipFilter = el('select', { class: 'input input--compact', 'aria-label': '会员状态' },
      el('option', { value: '' }, '全部学员'),
      el('option', { value: 'active' }, 'VIP 有效'),
      el('option', { value: 'none' }, '普通学员'));

    const tableSlot = el('div', { class: 'table-wrap' });
    const pagerSlot = el('div');

    const table = createTable({
      rowKey: (row) => row.id,
      columns: [
        { key: 'display_name', label: '学员', render: (row) => el('div', { class: 'cell-title' },
            el('span', { class: 'cell-title__main' }, row.display_name || '未设置昵称'),
            el('span', { class: 'cell-title__sub' }, maskPhone(row.phone)),
          ) },
        { key: 'vip', label: '会员', width: '150px', render: (row) => {
            const active = row.vip_expires_at && new Date(row.vip_expires_at).getTime() > Date.now();
            return active ? badge(`VIP 至 ${shortDate(row.vip_expires_at)}`, 'ok') : badge('普通', 'muted');
          } },
        { key: 'invite_code', label: '邀请码', width: '120px', render: (row) => row.invite_code || '—' },
        { key: 'created_at', label: '注册时间', width: '150px', render: (row) => shortDate(row.created_at) },
        { key: 'ops', label: '操作', width: '160px', align: 'right', render: (row) => el('div', { class: 'row-actions' },
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              on: { click: (event) => { event.stopPropagation(); openVip(row); } },
            }, '设置 VIP'),
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              on: { click: (event) => { event.stopPropagation(); navigate(`/admin/learners/${row.id}`); } },
            }, '详情'),
          ) },
      ],
    });

    learnerCtl = createListController({
      pageSize: 20,
      fetchPage: ({ page, pageSize, query }) => learners.list({ page, pageSize, q: query, vip: vipFilter.value }),
      onChange: ({ loading, rows, total, error, page }) => {
        if (error) { mount(tableSlot, errorState({ message: describeError(error), onRetry: () => learnerCtl.load() })); mount(pagerSlot); return; }
        table.render(rows);
        mount(tableSlot, table.root);
        if (loading) return;
        if (!rows.length) {
          mount(tableSlot, emptyState({ title: '没有匹配的学员', hint: '换一个关键词或筛选条件。' }));
          mount(pagerSlot);
          return;
        }
        if (total > learnerCtl.pageSize) {
          const pager = pagination({ page, pageSize: learnerCtl.pageSize, total, onChange: (next) => learnerCtl.load({ page: next }) });
          mount(pagerSlot, pager.root);
        } else mount(pagerSlot);
      },
    });

    let debounce = null;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => learnerCtl.load({ query: search.value.trim() }), 350);
    });
    vipFilter.addEventListener('change', () => learnerCtl.load());

    const wrap = el('div', null,
      el('div', { class: 'toolbar' }, search, vipFilter),
      tableSlot, pagerSlot,
    );
    learnerCtl.load();
    return wrap;
  }

  function openVip(row) {
    const active = row.vip_expires_at && new Date(row.vip_expires_at).getTime() > Date.now();
    const months = selectField({
      name: 'vip-months', label: '开通时长', value: '1',
      options: [
        { value: '1', label: '1 个月' },
        { value: '3', label: '3 个月' },
        { value: '6', label: '6 个月' },
        { value: '12', label: '12 个月' },
      ],
    });
    const note = textField({ name: 'vip-note', label: '备注', placeholder: '例如:邀请码兑换 / 客服补偿' });

    openModal({
      title: `设置 VIP · ${row.display_name || '未命名'}`,
      size: 'sm',
      body: el('div', null,
        el('p', { class: 'field__hint' }, active
          ? `当前 VIP 有效至 ${shortDate(row.vip_expires_at)}。再次开通会从到期日顺延。`
          : '当前为普通学员。开通后立即生效。'),
        formGrid(months.root, note.root),
      ),
      actions: [
        active
          ? { label: '取消 VIP', run: async () => { await setVip(row, { enabled: false }); } }
          : { label: '取消' },
        {
          label: '开通',
          variant: 'primary',
          run: async () => {
            const expires = new Date();
            expires.setMonth(expires.getMonth() + Number(months.value));
            await setVip(row, { enabled: true, expiresAt: expires.toISOString(), note: note.value });
          },
        },
      ],
    });
  }

  async function setVip(row, payload) {
    try {
      await learners.setVip(row.id, payload);
      toast('已更新', { variant: 'success' });
      await learnerCtl.load();
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }

  // ------------------------------------------------------------ 邀请码

  let inviteCtl = null;

  function invitesTab() {
    const statusFilter = el('select', { class: 'input input--compact', 'aria-label': '邀请码状态' },
      el('option', { value: '' }, '全部'),
      el('option', { value: 'unused' }, '未使用'),
      el('option', { value: 'used' }, '已使用'),
      el('option', { value: 'expired' }, '已过期'));

    const tableSlot = el('div', { class: 'table-wrap' });
    const pagerSlot = el('div');

    const table = createTable({
      rowKey: (row) => row.code,
      columns: [
        { key: 'code', label: '邀请码', render: (row) => el('code', { class: 'code' }, row.code) },
        { key: 'status', label: '状态', width: '100px', render: (row) => badge(row.status === 'used' ? '已使用' : row.status === 'expired' ? '已过期' : '可用',
            row.status === 'used' ? 'muted' : row.status === 'expired' ? 'warn' : 'ok') },
        { key: 'uses', label: '已用 / 上限', width: '110px', render: (row) => `${row.used_count ?? 0} / ${row.max_uses ?? 1}` },
        { key: 'expires_at', label: '过期时间', width: '150px', render: (row) => row.expires_at ? shortDate(row.expires_at) : '不过期' },
        { key: 'note', label: '备注', render: (row) => row.note || '—' },
        { key: 'ops', label: '操作', width: '120px', align: 'right', render: (row) => el('div', { class: 'row-actions' },
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              on: { click: async (event) => {
                event.stopPropagation();
                try { await navigator.clipboard.writeText(row.code); toast('已复制', { variant: 'success' }); }
                catch { toast('复制失败,请手动选择。', { variant: 'warn' }); }
              } },
            }, '复制'),
            row.status !== 'used' ? el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              on: { click: (event) => { event.stopPropagation(); revoke(row); } },
            }, '作废') : null,
          ) },
      ],
    });

    inviteCtl = createListController({
      pageSize: 20,
      fetchPage: ({ page, pageSize }) => learners.inviteCodes({ page, pageSize, status: statusFilter.value }),
      onChange: ({ loading, rows, total, error, page }) => {
        if (error) { mount(tableSlot, errorState({ message: describeError(error), onRetry: () => inviteCtl.load() })); mount(pagerSlot); return; }
        table.render(rows);
        mount(tableSlot, table.root);
        if (loading) return;
        if (!rows.length) {
          mount(tableSlot, emptyState({ title: '还没有邀请码', hint: '点击右上角生成。' }));
          mount(pagerSlot);
          return;
        }
        if (total > inviteCtl.pageSize) {
          const pager = pagination({ page, pageSize: inviteCtl.pageSize, total, onChange: (next) => inviteCtl.load({ page: next }) });
          mount(pagerSlot, pager.root);
        } else mount(pagerSlot);
      },
    });

    statusFilter.addEventListener('change', () => inviteCtl.load());

    const wrap = el('div', null,
      el('div', { class: 'toolbar' }, statusFilter,
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', on: { click: openGenerate } }, '生成邀请码'),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: exportAll } }, '导出 CSV'),
      ),
      tableSlot, pagerSlot,
    );
    inviteCtl.load();
    return wrap;
  }

  function openGenerate() {
    const count = textField({ name: 'invite-count', label: '生成数量', value: '10', autofocus: true });
    const maxUses = textField({ name: 'invite-uses', label: '每个可用次数', value: '1' });
    const expires = textField({ name: 'invite-expires', label: '过期日期', type: 'date' });
    const note = textField({ name: 'invite-note', label: '备注', placeholder: '例如:9 月推广' });
    const result = el('div', { class: 'invite-result' });

    openModal({
      title: '生成邀请码',
      body: el('div', null, formGrid(count.root, maxUses.root, expires.root, note.root), result),
      actions: [
        { label: '关闭' },
        {
          label: '生成',
          variant: 'primary',
          run: async () => {
            const n = Math.max(1, Math.min(200, Number(count.value) || 1));
            try {
              const payload = await learners.createInviteCodes({
                count: n,
                maxUses: Math.max(1, Number(maxUses.value) || 1),
                expiresAt: expires.value || null,
                note: note.value,
              });
              const codes = (payload.codes ?? []).map((row) => row.code ?? row);
              mount(result, el('div', null,
                el('p', { class: 'field__hint' }, `已生成 ${codes.length} 个邀请码:`),
                el('textarea', { class: 'input', rows: '6', readonly: true }, codes.join('\n')),
                el('button', {
                  class: 'btn btn--ghost btn--sm', type: 'button',
                  on: { click: async () => { try { await navigator.clipboard.writeText(codes.join('\n')); toast('已复制', { variant: 'success' }); } catch {} } },
                }, '复制全部'),
              ));
              toast('生成成功', { variant: 'success' });
              await inviteCtl?.load({ page: 1 });
              return false;   // keep the dialog open so the codes can be copied
            } catch (error) {
              toast(describeError(error), { variant: 'error' });
              return false;
            }
          },
        },
      ],
    });
  }

  async function revoke(row) {
    const ok = await confirm({ title: '作废邀请码', message: `作废后「${row.code}」将无法再被兑换。`, confirmLabel: '作废', danger: true });
    if (!ok) return;
    try {
      await learners.revokeInviteCode(row.code);
      toast('已作废', { variant: 'success' });
      await inviteCtl.load();
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }

  async function exportAll() {
    try {
      const all = await learners.inviteCodes({ page: 1, pageSize: 500 });
      const csv = learners.exportCsv(all.rows ?? []);
      // BOM so Excel on Windows opens the Chinese headers correctly.
      const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = el('a', { href: url, download: `eastudy-invite-codes-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }

  function renderTab() {
    mount(bodySlot, tab === 'learners' ? learnersTab() : invitesTab());
  }

  return {
    root,
    async mount() { renderTabs(); renderTab(); },
    unmount() {},
  };
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length !== 11) return phone || '';
  return `${digits.slice(0, 3)}****${digits.slice(7)}`;
}

function shortDate(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(date);
}

void setText;
