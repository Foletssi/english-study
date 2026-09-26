/* Eastudy V3 — 学员详情 (M09).

   The screen the 学员 list's 详情 button points at. Until now that button
   navigated to a route the admin router had never registered, so it landed on
   the fallback and bounced straight back to /admin — the endpoint it needs
   (/api/admin/learners/:id, with `activity`) has been serving this data all
   along.

   What this page is for: answering "why is this learner stuck". That means the
   profile, the VIP state, and the progress rows — not a general-purpose CRUD
   view. Nothing here edits learning data; the only write is VIP, which is the
   one thing an operator is expected to change on someone else's account.

   Two shapes of missing data are handled differently, and the difference
   matters:

   - `activity` missing entirely (the endpoint failed an auxiliary query, see
     its own note) still renders the profile. The operator came for the profile.
   - `progress_rows[].title` null renders the video id instead. The titles are
     attached server-side by the detail endpoint (`withTitles`), so the page
     never has to page through /api/admin/videos to name the rows — a lookup
     that could only ever cover the first page of videos, and whose failure
     would have to be swallowed anyway. */

import { el, mount, setText } from '../../core/dom.js';
import { createTable, emptyState, errorState, toast } from '../../ui/index.js';
import { openModal, confirm } from '../../ui/modal.js';
import { textField, selectField, formGrid } from '../../ui/field.js';
import { badge, progressBar } from '../../ui/status.js';
import { describeError } from '../../services/index.js';

export function createLearnerDetailPage({ learners, navigate, params }) {
  const userId = params?.id || '';

  const titleSlot = el('h1', { class: 'page__title' }, '学员详情');
  const subtitleSlot = el('p', { class: 'page__subtitle' });
  const vipSlot = el('div', { class: 'page__actions' });
  const bodySlot = el('div', { class: 'learner-detail' });

  const root = el('div', { class: 'page learner-detail-page' },
    el('header', { class: 'page__head' },
      // A real anchor, so the browser's own back-button and middle-click work;
      // the click handler only stops the hash change from being the navigation.
      el('a', {
        class: 'page__back', href: '#/admin/learners',
        on: { click: (event) => { event.preventDefault(); navigate('/admin/learners'); } },
      }, '← 返回学员列表'),
      titleSlot,
      subtitleSlot,
      vipSlot,
    ),
    bodySlot,
  );

  let current = null;

  async function load() {
    if (!userId) {
      mount(bodySlot, emptyState({ title: '没有指定学员', hint: '请从学员列表进入详情。' }));
      return;
    }
    mount(bodySlot, el('div', { class: 'skeleton skeleton--rows' }));
    try {
      const payload = await learners.get(userId);
      current = payload.learner ?? null;
      if (!current) throw new Error('响应缺少 learner 字段');
      render(payload.activity ?? null);
    } catch (error) {
      mount(bodySlot, errorState({ message: describeError(error), onRetry: load }));
    }
  }

  function render(activity) {
    const learner = current;
    const name = learner.display_name || '未设置昵称';
    setText(titleSlot, name);
    setText(subtitleSlot, learner.is_vip
      ? `VIP 有效至 ${shortDate(learner.vip_expires_at)}`
      : '普通学员');

    const vipButton = el('button', {
      class: 'btn btn--primary', type: 'button',
      on: { click: () => openVip(learner) },
    }, learner.is_vip ? '管理 VIP' : '开通 VIP');
    mount(vipSlot, vipButton);

    mount(bodySlot,
      el('section', { class: 'dash__cards' },
        // Null activity means the numbers are unknown, not zero — an operator
        // reading "0 已学完" would draw the wrong conclusion about a learner
        // whose progress table simply failed to load.
        statCard('已学完', activity ? activity.completed_count : null),
        statCard('学习中', activity ? activity.learning_count : null),
        statCard('生词', activity ? activity.vocabulary_count : null),
        statCard('关注表达', activity ? activity.following_count : null),
      ),
      profileCard(learner),
      progressCard(activity),
      plansCard(activity),
    );
  }

  function statCard(label, value) {
    return el('article', { class: `dash-card${value == null ? ' is-unknown' : ''}` },
      el('p', { class: 'dash-card__value' }, value == null ? '—' : String(value)),
      el('p', { class: 'dash-card__label' }, label),
    );
  }

  function profileCard(learner) {
    return el('section', { class: 'card' },
      el('h2', { class: 'card__title' }, '账号'),
      el('div', { class: 'profile-fields' },
        profileField('昵称', learner.display_name || '未设置'),
        // Full number here, unlike the masked list: an operator who opened the
        // detail page is looking this person up, and a masked number cannot be
        // read back to whoever is on the phone.
        profileField('手机号', learner.phone || '未绑定'),
        profileField('角色', learner.role === 'admin' ? badge('管理员', 'ok') : '学员'),
        profileField('会员状态', learner.is_vip
          ? badge(`VIP 至 ${shortDate(learner.vip_expires_at)}`, 'ok')
          : badge('普通', 'muted')),
        profileField('使用邀请码', learner.invite_code || '—'),
        profileField('注册时间', longDate(learner.created_at)),
      ),
    );
  }

  function profileField(label, value) {
    return el('div', { class: 'profile-field' },
      el('span', { class: 'profile-field__label' }, label),
      el('span', { class: 'profile-field__value' }, value),
    );
  }

  function progressCard(activity) {
    const rows = activity?.progress_rows ?? [];
    const table = createTable({
      rowKey: (row) => row.video_id,
      columns: [
        // `row.title` comes from the endpoint's batched lookup, which reaches
        // every id on the page. `title` attribute stays the raw id either way,
        // so the operator can copy it out when a video really is gone.
        { key: 'video', label: '视频', render: (row) => el('div', { class: 'cell-title' },
            el('span', {
              class: 'cell-title__main',
              title: row.video_id || '',
            }, row.title || shortId(row.video_id)),
          ) },
        { key: 'coverage', label: '进度', width: '200px', render: (row) => progressBar((row.coverage || 0) * 100, {
            label: `${Math.round((row.coverage || 0) * 100)}%`,
          }) },
        { key: 'completed', label: '状态', width: '90px', render: (row) => (row.completed
            ? badge('已学完', 'ok')
            : (row.coverage || 0) > 0.02 ? badge('学习中', 'busy') : badge('未开始', 'muted')) },
        { key: 'updated_at', label: '最后更新', width: '150px', render: (row) => shortDate(row.updated_at) },
      ],
    });
    table.render(rows);

    return el('section', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', { class: 'card__title' }, '学习记录'),
        el('span', { class: 'card__meta' }, activity ? `共 ${rows.length} 条` : '未能载入'),
      ),
      activity
        ? (rows.length
            ? el('div', { class: 'table-wrap' }, table.root)
            // An empty progress table is a real answer ("this learner has not
            // opened anything"), not an error, so it gets an empty state rather
            // than a retry.
            : emptyState({ title: '还没有学习记录', hint: '该学员尚未开始观看任何视频。' }))
        : el('p', { class: 'field__hint' }, '学习数据暂时无法读取,页面其余部分不受影响。'),
    );
  }

  function plansCard(activity) {
    const plans = activity?.plans ?? [];
    if (!activity) return null;
    if (!plans.length) {
      return el('section', { class: 'card' },
        el('h2', { class: 'card__title' }, '学习计划'),
        emptyState({ title: '没有学习计划', hint: '该学员还没有创建计划。' }),
      );
    }
    return el('section', { class: 'card' },
      el('h2', { class: 'card__title' }, `学习计划 · ${plans.length}`),
      el('ul', { class: 'plan-list' }, ...plans.map((plan) => el('li', { class: 'plan-list__row' },
        el('span', { class: 'plan-list__title' }, plan.title || '未命名计划'),
        plan.target_date ? el('span', { class: 'plan-list__meta' }, `目标 ${shortDate(plan.target_date)}`) : null,
      ))),
    );
  }

  /* Same modal as the list page, minus one difference: revoking asks first.
     On the list the button is next to a row you just searched for; here it is
     the primary action of a page an operator opened on purpose, and "管理 VIP →
     取消 VIP" is one click with no undo. */
  function openVip(learner) {
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
      title: `设置 VIP · ${learner.display_name || '未命名'}`,
      size: 'sm',
      body: el('div', null,
        el('p', { class: 'field__hint' }, learner.is_vip
          ? `当前 VIP 有效至 ${shortDate(learner.vip_expires_at)}。再次开通会从到期日顺延。`
          : '当前为普通学员。开通后立即生效。'),
        formGrid(months.root, note.root),
      ),
      actions: [
        learner.is_vip
          ? {
            label: '取消 VIP',
            run: async () => {
              const ok = await confirm({
                title: '取消 VIP',
                message: `取消后「${learner.display_name || '该学员'}」将立即失去会员权限。`,
                confirmLabel: '取消 VIP', danger: true,
              });
              if (!ok) return false;          // keep the VIP dialog open
              await setVip(learner, { enabled: false });
            },
          }
          : { label: '取消' },
        {
          label: '开通',
          variant: 'primary',
          run: async () => {
            const expires = new Date();
            expires.setMonth(expires.getMonth() + Number(months.value));
            await setVip(learner, { enabled: true, expiresAt: expires.toISOString(), note: note.value });
          },
        },
      ],
    });
  }

  async function setVip(learner, payload) {
    try {
      await learners.setVip(learner.id, payload);
      toast('已更新', { variant: 'success' });
      await load();     // re-read: the server owns vip_expires_at, not this page
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }

  return {
    root,
    async mount() { await load(); },
    unmount() {},
  };
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : '未知视频';
}

function shortDate(input) {
  const value = toDate(input);
  return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(value) : '—';
}

function longDate(input) {
  const value = toDate(input);
  return value
    ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(value)
    : '—';
}

function toDate(input) {
  if (!input) return null;
  const value = new Date(input);
  return Number.isNaN(value.getTime()) ? null : value;
}
