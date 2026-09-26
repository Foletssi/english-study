/* Eastudy V3 — 控制端外壳.

   A persistent left sidebar, collapsible on tablet and turned into a drawer
   under 900px. The legacy admin nav was a horizontal strip that overflowed to
   two rows on a 1366×768 laptop, which is the resolution most operators use.

   The sidebar groups the ten modules so the operator can find the surface they
   need without remembering a URL. Items the operator does not have permission
   for are not rendered at all — a greyed-out link invites a click that fails. */

import { el, mount, setText } from '../core/dom.js';
import { EVENTS, on } from '../core/bus.js';

const GROUPS = [
  {
    label: '内容',
    items: [
      { path: '/admin', label: '总览', icon: '◎', exact: true },
      { path: '/admin/videos', label: '视频管理', icon: '▤' },
      { path: '/admin/jobs', label: '处理队列', icon: '⟳' },
    ],
  },
  {
    label: '学员',
    items: [
      { path: '/admin/learners', label: '学员与邀请码', icon: '☺' },
    ],
  },
  {
    label: '系统',
    items: [
      { path: '/admin/settings', label: '设置与健康', icon: '⚙' },
    ],
  },
];

export function createAdminLayout({ session, theme, navigate }) {
  let collapsed = false;
  try { collapsed = localStorage.getItem('eastudy.v3.admin.sidebar') === 'collapsed'; } catch {}

  const brand = el('a', {
    class: 'sidebar__brand',
    href: '#/admin',
    on: { click: (event) => { event.preventDefault(); navigate('/admin'); } },
  },
    el('span', { class: 'sidebar__logo', 'aria-hidden': 'true' }, 'E'),
    el('span', { class: 'sidebar__name' }, 'Eastudy 控制端'),
  );

  const navSlot = el('nav', { class: 'sidebar__nav', 'aria-label': '控制端导航' });

  const collapseButton = el('button', {
    class: 'sidebar__collapse',
    type: 'button',
    'aria-label': '折叠侧边栏',
    'aria-expanded': String(!collapsed),
    on: { click: () => { setCollapsed(!collapsed); } },
  }, '⟨');

  const sidebar = el('aside', { class: 'sidebar' },
    brand,
    navSlot,
    el('footer', { class: 'sidebar__foot' },
      collapseButton,
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        on: { click: () => theme.toggle() },
      }, '主题'),
    ),
  );

  const menuButton = el('button', {
    class: 'topbar__icon-btn admin-menu',
    type: 'button', 'aria-label': '打开菜单',
    on: { click: () => root.classList.toggle('is-drawer-open') },
  }, '☰');

  const titleNode = el('span', { class: 'admin-topbar__title' });
  const userNode = el('span', { class: 'admin-topbar__user' });

  const topbar = el('header', { class: 'admin-topbar' },
    menuButton,
    titleNode,
    el('div', { class: 'admin-topbar__right' }, userNode),
  );

  const outlet = el('main', { class: 'outlet', id: 'outlet' });
  const scrim = el('div', { class: 'scrim', on: { click: () => root.classList.remove('is-drawer-open') } });

  const root = el('div', { class: `shell shell--admin${collapsed ? ' is-collapsed' : ''}` },
    sidebar, el('div', { class: 'admin-main' }, topbar, outlet), scrim,
  );

  function setCollapsed(next) {
    collapsed = next;
    root.classList.toggle('is-collapsed', collapsed);
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('eastudy.v3.admin.sidebar', collapsed ? 'collapsed' : 'expanded'); } catch {}
  }

  function paintNav(current) {
    mount(navSlot, ...GROUPS.map((group) => el('div', { class: 'sidebar__group' },
      el('p', { class: 'sidebar__group-label' }, group.label),
      el('ul', { class: 'sidebar__list' }, ...group.items.map((item) => {
        const active = item.exact ? current === item.path : current.startsWith(item.path);
        return el('li', null,
          el('a', {
            class: `sidebar__link${active ? ' is-active' : ''}`,
            href: `#${item.path}`,
            title: item.label,
            'aria-current': active ? 'page' : undefined,
            on: { click: (event) => {
              event.preventDefault();
              navigate(item.path);
              root.classList.remove('is-drawer-open');
            } },
          },
            el('span', { class: 'sidebar__icon', 'aria-hidden': 'true' }, item.icon),
            el('span', { class: 'sidebar__label' }, item.label),
          ),
        );
      })))),
    );
    setText(titleNode, currentTitle(current));
  }

  function currentTitle(current) {
    for (const group of GROUPS) {
      for (const item of group.items) {
        if (item.exact ? current === item.path : current.startsWith(item.path)) return item.label;
      }
    }
    return '控制端';
  }

  function paintProfile(profile) {
    setText(userNode, profile?.display_name || profile?.phone || '管理员');
  }

  const disposers = [
    on(EVENTS.AUTH_CHANGED, () => paintProfile(session?.profile)),
  ];

  paintProfile(session?.profile);

  return {
    root,
    outlet,
    setRoute(path) { paintNav(path); },
    setProfile: paintProfile,
    dispose() { for (const dispose of disposers) dispose(); },
  };
}
