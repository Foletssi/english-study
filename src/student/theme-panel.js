/* 12 套色系的选择面板.

   为什么是"面板"而不是继续用顶栏那颗按钮循环:
   上一版按钮在 light → dark → warm 三态里转圈。三态还能转, 12 套不能 ——
   要轮到第 9 套得点 8 次, 而且每次都得记住自己点到哪了。选择超过 5 项就
   该给出一个能一眼看全的列表, 这是菜单的适用范围, 不是循环的。

   于是按钮的动作拆成两个, 各管一个频率:
     单击  …… 翻明暗。这是高频动作, 一次点击一次可见变化。
     长按 / 右键 …… 打开这个面板。低频动作, 但一打开就能看全 24 种外观。

   色卡上的颜色是**从 CSS 读回来的**, 不是在这里再抄一份。见 readThemeSwatches
   的注释: 抄一份色值, 面板描述的就是"我写这个文件时的那一屏", 以后改了
   themes-12.css 就会两边对不上, 而没有人会记得回来改这里。

   面板本身是一层 dialog: 有焦点陷阱、Esc 关闭、点遮罩关闭 —— 这些都走
   ui/modal.js, 和站内其它弹层同一套行为, 不另起一份。 */

import { el, mount } from '../core/dom.js';
import { openModal } from '../ui/modal.js';
import { THEMES, MODES, readThemeSwatches } from '../ui/theme.js';

const MODE_LABEL = { light: '浅色', dark: '深色' };

/** 打开选择面板。返回一个 promise, 关闭后 resolve。 */
export function openThemePanel(theme) {
  const swatches = new Map(readThemeSwatches().map((s) => [s.id, s]));

  const grid = el('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': '配色方案' });

  /* 每套主题是一张卡, 卡里并排放着它的浅色版和深色版两个色卡。
     两张色卡**都是可点的**: 点哪一张就同时选定色系和那个模式 —— 用户看到
     "深色版长这样", 点它就是想要这样, 不该再让他先点色系、再点深浅两步。 */
  for (const item of THEMES) {
    const pair = el('div', { class: 'theme-card__pair' });
    const card = el('div', {
      class: 'theme-card',
      'data-theme-id': item.id,
    },
      el('div', { class: 'theme-card__head' },
        el('span', { class: 'theme-card__name' }, item.name),
        el('span', { class: 'theme-card__note' }, item.note),
      ),
      pair,
    );

    for (const mode of MODES) {
      const sw = swatches.get(item.id)?.[mode] ?? { page: '', card: '', primary: '', highlight: '' };
      const chip = el('button', {
        class: 'theme-chip',
        type: 'button',
        role: 'radio',
        'data-theme-id': item.id,
        'data-mode': mode,
        'aria-checked': 'false',
        'aria-label': `${item.name}${MODE_LABEL[mode]}版`,
        on: {
          click: () => {
            theme.setTheme(item.id);
            theme.setMode(mode);
            close();
          },
        },
      },
        /* 三色预览: 底色 / 卡片色 / 主色 + 重点色。四个色块比一个圆点更能
           说明"这套配色长什么样" —— 只有主色的话, 12 套里有好几套会看起来
           差不多。 */
        el('span', { class: 'theme-chip__swatch', style: `background:${sw.page}` },
          el('span', { class: 'theme-chip__card', style: `background:${sw.card}` }),
          el('span', { class: 'theme-chip__dot', style: `background:${sw.primary}` }),
          el('span', { class: 'theme-chip__dot theme-chip__dot--alt', style: `background:${sw.highlight}` }),
        ),
        el('span', { class: 'theme-chip__label' }, MODE_LABEL[mode]),
      );
      pair.append(chip);
    }

    grid.append(card);
  }

  const body = el('div', { class: 'theme-panel' },
    el('p', { class: 'theme-panel__hint' }, '点任意一张色卡即可切换。选定后长按顶栏按钮可以再打开这里。'),
    grid,
  );

  /* 勾选态在每次主题变化后重画 —— 面板开着的时候, 系统跟随切换、或者用户在
     另一个标签页里改了主题, 也可能把当前主题挪走。 */
  function syncChecked() {
    for (const chip of grid.querySelectorAll('.theme-chip')) {
      const on = chip.dataset.themeId === theme.theme && chip.dataset.mode === theme.mode;
      chip.setAttribute('aria-checked', on ? 'true' : 'false');
      chip.classList.toggle('is-active', on);
    }
    for (const card of grid.querySelectorAll('.theme-card')) {
      card.classList.toggle('is-current', card.dataset.themeId === theme.theme);
    }
  }

  /* 订阅要在**关掉面板时**解掉。挂在 bus 上不管的话, 每开关一次面板就多留
     一个死监听, 而且它会一直重画一个已经不在文档里的 grid —— 开关几十次之后
     切一次主题要跑几十份没人看的 DOM 操作。
     openModal 的 close 是闭包不是方法, 包不住; 所以用 onClose 回调, 它是
     唯一的退出路径(Esc / 点遮罩 / 点色卡都走它)。 */
  const off = theme.onChange(syncChecked);
  const modal = openModal({
    title: '配色方案',
    body,
    size: 'lg',
    onClose: () => off(),
  });

  syncChecked();
  return modal;
}
