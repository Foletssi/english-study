/* Eastudy V3 — 我的账号 (M01).

   Profile, VIP state, and the invite-code redemption the legacy buried three
   taps deep. Whether VIP is active is computed from `vip_expires_at` on every
   render rather than from a stored boolean, so an expired membership stops
   being "active" without a cron job. */

import { el, mount, setText } from '../../core/dom.js';
import { EVENTS, on } from '../../core/bus.js';
import { textField, selectField } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { emptyState, errorState } from '../../ui/index.js';
import { THEMES } from '../../ui/theme.js';
import { openThemePanel } from '../theme-panel.js';
import { describeError } from '../../services/index.js';

export function createAccountPage({ api, progress, session, navigate, theme }) {
  const summarySlot = el('section', { class: 'account__summary' });
  const statsSlot = el('section', { class: 'account__stats' });
  const inviteSlot = el('section', { class: 'account__invite' });
  const themeSlot = el('section', { class: 'account__theme' });

  const root = el('div', { class: 'page account' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, '我的账号'),
    ),
    summarySlot,
    statsSlot,
    themeSlot,
    inviteSlot,
  );

  function isVipActive(profile) {
    if (!profile?.vip_expires_at) return false;
    return new Date(profile.vip_expires_at).getTime() > Date.now();
  }

  function renderSummary(profile) {
    const active = isVipActive(profile);
    mount(summarySlot,
      el('div', { class: 'account-card' },
        el('div', { class: 'account-card__row' },
          el('span', { class: 'account-card__label' }, '昵称'),
          el('span', { class: 'account-card__value' }, profile?.display_name || '未设置'),
        ),
        el('div', { class: 'account-card__row' },
          el('span', { class: 'account-card__label' }, '手机号'),
          el('span', { class: 'account-card__value' }, maskPhone(profile?.phone)),
        ),
        el('div', { class: 'account-card__row' },
          el('span', { class: 'account-card__label' }, '会员状态'),
          el('span', { class: `account-card__value${active ? ' is-vip' : ''}` },
            active
              ? `VIP 有效至 ${formatDate(profile.vip_expires_at)}`
              : '普通学员'),
        ),
        el('div', { class: 'account-card__actions' },
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => editProfile(profile) } }, '修改昵称'),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => session.signOut() } }, '退出登录'),
        ),
      ),
    );
  }

  function renderStats() {
    const rows = progress.rows;
    const completed = rows.filter((row) => row.completed).length;
    const learning = rows.filter((row) => !row.completed && (row.coverage || 0) > 0.02).length;
    mount(statsSlot,
      el('h2', { class: 'section__title' }, '学习数据'),
      el('div', { class: 'stat-row' },
        stat('已完成', String(completed)),
        stat('学习中', String(learning)),
        stat('有记录的视频', String(rows.length)),
      ),
      el('div', { class: 'account__links' },
        el('button', { class: 'btn btn--ghost', type: 'button', on: { click: () => navigate('/plan') } }, '学习计划'),
        el('button', { class: 'btn btn--ghost', type: 'button', on: { click: () => navigate('/vocabulary') } }, '我的词汇'),
      ),
    );
  }

  function stat(label, value) {
    return el('div', { class: 'stat' },
      el('span', { class: 'stat__value' }, value),
      el('span', { class: 'stat__label' }, label),
    );
  }

  /* 外观设置。两个控件, 各管一半 —— 因为外观本来就是两个正交维度:

       配色方案  …… 12 套色系 (theme-01..12)
       明暗      …… 浅色 / 深色 / 跟随系统

     拆成两个而不是合成一个 36 项的长列表: 合成之后"深色"会重复 12 次, 用户
     要在里面找"我是哪套色系的深色"。拆开之后每一项都短, 而且"换色系不动
     明暗"这件事从界面结构上就成立了。

     顶栏那颗按钮是**快捷方式**, 不是唯一入口 —— 它只翻明暗。12 套色系和
     "跟随系统"必须在这里有显式入口, 否则只用顶栏的人永远回不到跟随系统,
     也永远发现不了还有另外 11 套颜色。 */
  function renderTheme() {
    if (!theme) return;

    const themeField = selectField({
      name: 'theme',
      label: '配色方案',
      value: theme.theme,
      options: THEMES.map((t) => ({ value: t.id, label: `${t.name}(${t.note})` })),
      hint: '12 套配色, 每套都有浅色和深色两个版本。',
    });
    themeField.onChange(() => { theme.setTheme(themeField.value); });

    const modeField = selectField({
      name: 'mode',
      label: '明暗',
      value: theme.preference,
      options: [
        { value: 'system', label: '跟随系统' },
        { value: 'light', label: '浅色' },
        { value: 'dark', label: '深色' },
      ],
      hint: '跟随系统时会随手机的日夜模式自动切换;顶栏那颗按钮可以随时手动翻过来。',
    });
    modeField.onChange(() => { theme.setMode(modeField.value); });

    // 顶栏按钮(或面板)改了主题, 这里两个下拉要跟着走 —— 三处控件指向同一个
    // 状态, 不同步的话用户会看到"下拉框说浅色、页面是深色"。
    const off = on(EVENTS.THEME_CHANGED, ({ theme: id, mode, preference }) => {
      if (themeField.value !== id) themeField.value = id;
      if (modeField.value !== preference) modeField.value = preference;
      void mode;
    });

    mount(themeSlot,
      el('h2', { class: 'section__title' }, '外观'),
      el('div', { class: 'field-row' }, themeField.root, modeField.root),
      el('p', { class: 'account__theme-actions' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          on: { click: () => openThemePanel(theme) },
        }, '打开配色面板'),
      ),
    );
    return off;
  }

  function renderInvite() {
    const field = textField({ name: 'invite', label: '兑换邀请码', placeholder: '输入邀请码', hint: '兑换成功后会立即开通会员。' });
    const submit = el('button', {
      class: 'btn btn--primary', type: 'button',
      on: { click: redeem },
    }, '兑换');

    async function redeem() {
      const code = field.value.trim().toUpperCase();
      if (!code) { field.setError('请输入邀请码'); return; }
      submit.disabled = true;
      try {
        const result = await api.post('/api/invite-codes/redeem', { code }, { retry: false });
        field.setError('');
        toast(result?.message || '兑换成功', { variant: 'success' });
        field.value = '';
        await session.refresh();
        renderSummary(session.profile);
      } catch (error) {
        field.setError(describeError(error));
      } finally {
        submit.disabled = false;
      }
    }

    mount(inviteSlot,
      el('h2', { class: 'section__title' }, '邀请码'),
      el('div', { class: 'invite-row' }, field.root, submit),
    );
  }

  function editProfile(profile) {
    const name = textField({ name: 'display-name', label: '昵称', value: profile?.display_name || '', required: true, autofocus: true });
    import('../../ui/modal.js').then(({ openModal }) => {
      openModal({
        title: '修改昵称',
        size: 'sm',
        body: name.root,
        actions: [
          { label: '取消' },
          {
            label: '保存',
            variant: 'primary',
            run: async () => {
              if (!name.value) { name.setError('昵称不能为空'); return false; }
              try {
                await api.patch('/api/profile', { display_name: name.value }, { retry: false });
                await session.refresh();
                renderSummary(session.profile);
                toast('已保存', { variant: 'success' });
                return true;
              } catch (error) {
                name.setError(describeError(error));
                return false;
              }
            },
          },
        ],
      });
    });
  }

  // 页面卸载时退订,否则每进一次"我的"就多挂一个监听器 —— 主题是全局单例,
  // 它不会跟着页面一起消失,这些回调会一直攒着.
  let offTheme = null;

  return {
    root,
    async mount() {
      try {
        await progress.fetchAll();
      } catch {
        // Stats degrade to zeros; the account card still renders.
      }
      renderSummary(session.profile);
      renderStats();
      offTheme?.();
      offTheme = renderTheme() ?? null;
      renderInvite();
    },
    unmount() { offTheme?.(); offTheme = null; },
  };
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length !== 11) return phone || '—';
  return `${digits.slice(0, 3)}****${digits.slice(7)}`;
}

function formatDate(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium' }).format(date);
}
