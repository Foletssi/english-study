/* Eastudy V3 — 学员端外壳.

   A top bar for desktop, a bottom tab bar for mobile. The legacy used the same
   horizontal nav at every width, so on a phone the six links wrapped onto two
   lines and pushed the content below the fold. The bottom bar is the pattern
   learners already know from every app on their phone. */

import { el, mount, setText } from '../core/dom.js';
import { EVENTS, on } from '../core/bus.js';
import { icon } from '../ui/icons.js';
import { THEMES } from '../ui/theme.js';
import { openThemePanel } from './theme-panel.js';

/* 每个条目带图形名而不是字符 —— 理由见 ui/icons.js 顶部 */
const NAV = [
  { path: '/', label: '首页', icon: 'home' },
  { path: '/catalog', label: '视频库', icon: 'library' },
  { path: '/plan', label: '计划', icon: 'plan' },
  { path: '/vocabulary', label: '词汇', icon: 'vocabulary' },
  { path: '/account', label: '我的', icon: 'account' },
];

/* 按钮的 aria-label 要说清"当前是哪套", 否则读屏用户按下去只听到"切换主题",
   不知道变到了哪里。这里报的是**模式**加**色系名**, 因为 24 种外观里模式的
   差异(明暗)是唯一能一句话说清的, 色系名补上剩下的一半。 */
const MODE_NAMES = { light: '浅色', dark: '深色' };
const THEME_NAME_BY_ID = new Map(THEMES.map((t) => [t.id, t.name]));

/* 长按判定: 500ms 是"按住"与"点击"的经验分界 —— 短于它多半是手抖, 长于它
   用户会以为按钮坏了。移动端没有右键, 长按是唯一能表达"还有别的选项"的手势。 */
const LONG_PRESS_MS = 500;

export function createStudentLayout({ session, theme, navigate }) {
  const brand = el('a', {
    class: 'topbar__brand',
    href: '#/',
    on: { click: (event) => { event.preventDefault(); navigate('/'); } },
  },
    el('span', { class: 'topbar__logo', 'aria-hidden': 'true' }, 'E'),
    el('span', { class: 'topbar__name' }, 'Eastudy'),
  );

  const navLinks = el('nav', { class: 'topbar__nav', 'aria-label': '主导航' });
  const tabBar = el('nav', { class: 'tabbar', 'aria-label': '主导航' });

  const searchButton = el('button', {
    class: 'topbar__icon-btn', type: 'button', 'aria-label': '搜索',
    on: { click: () => navigate('/catalog') },
  }, icon('search', { size: 20 }));

  /* 两个动作, 两个频率:

       单击       …… 翻浅深。高频动作, 而且**每次都真的改变屏幕**。
       长按/右键  …… 打开 12 套色系面板。低频动作, 一打开能看全 24 种外观。

     为什么不是"点一次换一套色系": 12 套要点到第 9 套得点 8 次, 而且中间
     那几次屏幕只是换了颜色、明暗不变, 用户分不清"点到了没有"。翻明暗是
     最直观的可见变化, 留着它当主动作。

     图标由 theme 那边给出(`glyph`), 页面不自己判断当前是什么主题 ——
     判断逻辑散在两处时, 加第 13 套色系必然漏改一处。 */
  const themeButton = el('button', {
    class: 'topbar__icon-btn', type: 'button',
    'aria-label': themeLabel(theme),
    title: '单击切换浅色/深色, 长按选择配色',
    on: {
      click: (event) => {
        /* 长按之后浏览器还会补一次 click, 那一下不能再翻一次明暗 ——
           用户按住是为了开面板, 松手却把主题翻掉了。 */
        if (suppressClick) { suppressClick = false; return; }
        if (event.detail === 0) return;   // 键盘 Enter 走 keydown 那条路
        theme.toggle();
      },
      contextmenu: (event) => { event.preventDefault(); openPanel(); },
      pointerdown: (event) => {
        if (event.button !== 0) return;
        longPressTimer = setTimeout(() => {
          suppressClick = true;
          openPanel();
        }, LONG_PRESS_MS);
      },
      pointerup: () => { clearTimeout(longPressTimer); },
      pointercancel: () => { clearTimeout(longPressTimer); },
      pointerleave: () => { clearTimeout(longPressTimer); },
      keydown: (event) => {
        /* 键盘用户没有"长按"这个概念, 所以 Enter/Space 翻明暗、Shift+Enter
           开面板。别让一个手势成为唯一入口。 */
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (event.shiftKey) openPanel(); else theme.toggle();
      },
    },
  }, icon(theme.glyph ?? 'sun', { size: 20 }));

  let longPressTimer = null;
  let suppressClick = false;
  let panelOpen = false;

  function openPanel() {
    /* 已经开着就不再开一个 —— 长按触发之后 contextmenu 还可能补一发, 双击
       长按也会。重复开会在 <body> 上叠出两层 dialog, Esc 只关掉最上面那层,
       用户以为按钮坏了。 */
    if (panelOpen) return;
    panelOpen = true;
    const modal = openThemePanel(theme);
    /* openThemePanel 返回的 close 是闭包, 这里只能轮询它的 dialog 是否还在
       文档里 —— 代价是一次 rAF 级的检查, 换来"面板关了之后按钮能再打开"。
       比改 openModal 的返回契约便宜。 */
    const tick = () => {
      if (!modal.dialog.isConnected) { panelOpen = false; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function themeLabel(controller) {
    const mode = MODE_NAMES[controller.mode] ?? '浅色';
    const name = THEME_NAME_BY_ID.get(controller.theme) ?? '';
    return `切换主题(当前:${name}${mode}版)`;
  }

  const vipBadge = el('span', { class: 'topbar__vip', hidden: true }, 'VIP');

  const avatar = el('button', {
    class: 'topbar__avatar', type: 'button', 'aria-label': '我的账号',
    on: { click: () => navigate('/account') },
  }, '?');

  const topbar = el('header', { class: 'topbar' },
    brand,
    navLinks,
    el('div', { class: 'topbar__right' }, searchButton, vipBadge, themeButton, avatar),
  );

  const outlet = el('main', { class: 'outlet', id: 'outlet' });
  const root = el('div', { class: 'shell shell--student' }, topbar, outlet, tabBar);

  /* `mount` clears before it appends, so the top-bar links are rebuilt from
     scratch on every navigation. The loop that used to sit above this appended
     a duplicate set that the following `mount` immediately threw away — it
     never reached the screen, and it re-registered every click handler. */
  function paintNav(current) {
    mount(navLinks, ...NAV.map((item) => el('a', {
      class: `topbar__link${isActive(current, item.path) ? ' is-active' : ''}`,
      href: `#${item.path}`,
      'aria-current': isActive(current, item.path) ? 'page' : undefined,
      on: { click: (event) => { event.preventDefault(); navigate(item.path); } },
    }, item.label)));

    mount(tabBar, ...NAV.map((item) => el('a', {
      class: `tabbar__item${isActive(current, item.path) ? ' is-active' : ''}`,
      href: `#${item.path}`,
      on: { click: (event) => { event.preventDefault(); navigate(item.path); } },
    },
      /* 图标本身 `aria-hidden`,标签文字留在外层 span 里 —— 读屏只念一次
         "视频库", 而不是"图标 视频库". 描边用 CSS 的 currentColor 继承,
         高亮切换时图标跟着变色, 不需要第二套资源。 */
      el('span', { class: 'tabbar__icon' }, icon(item.icon, { size: 22 })),
      el('span', { class: 'tabbar__label' }, item.label),
    )));
  }

  function isActive(current, path) {
    if (path === '/') return current === '/' || current === '';
    return current.startsWith(path);
  }

  function paintProfile(profile) {
    const initial = (profile?.display_name || '').trim().slice(0, 1);
    setText(avatar, initial || '我');
    const active = profile?.vip_expires_at && new Date(profile.vip_expires_at).getTime() > Date.now();
    vipBadge.hidden = !active;
  }

  const disposers = [
    on(EVENTS.THEME_CHANGED, () => {
      /* `setText` 只写文本,而这里要换的是整个 SVG 节点,所以走 `mount` —— 图标
         是图形不是文案,拿 `setText` 写进去只会得到一串 "[object DocumentFragment]"。 */
      mount(themeButton, icon(theme.glyph ?? 'sun', { size: 20 }));
      themeButton.setAttribute('aria-label', themeLabel(theme));
    }),
    on(EVENTS.AUTH_CHANGED, () => paintProfile(session?.profile)),
  ];

  paintProfile(session?.profile);

  return {
    root,
    outlet,
    setRoute(path) { paintNav(path); },
    setProfile: paintProfile,
    dispose() {
      /* 定时器要一起收掉: 布局被销毁(切账号、热重载)时如果还挂着一个长按
         定时器, 500ms 后它会去开一个已经没有宿主的面板。 */
      clearTimeout(longPressTimer);
      for (const dispose of disposers) dispose();
    },
  };
}
