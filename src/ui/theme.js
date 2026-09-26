/* Eastudy — theme control.

   12 套配色 × 浅色/深色 = 24 种外观, 两个属性各管一件事:

     data-theme="theme-01..12"   哪一套色系
     data-mode="light|dark"      这一套的浅色版还是深色版

   ---------------------------------------------------------------------------
   为什么不是"24 套主题"

   把 12 × 2 展平成 24 个平级主题是最省事的写法, 也是最先会烂掉的写法: 每套
   色系的深浅两版共享同一份组件样式, 只是变量不同 —— 展平之后这个关系就丢
   了, 加第 13 套要写两个独立块, 而且没法表达"同一个主题换个模式"。
   两个属性正交地表达它, 组件层永远只认语义变量。

   ---------------------------------------------------------------------------
   顶栏那颗按钮的行为

   按钮只有一个, 要表达 24 种状态。做法是把"成套选"和"翻面"分开:

     - 单击  …… 翻 light / dark。这是绝大多数人唯一会用的动作, 而且**每次都
                  真的改变屏幕**, 这一点由下面的 invariant 测试守着。
     - 长按 / 菜单 …… 打开 12 套色系的选择面板。

   `system` 从三态循环里的一个位置降级成"一个模式偏好": 它只决定 mode 的起
   始值, 不再占循环里的位置。原来的三态循环里 system 是循环外的一个入口, 现在
   没有循环了, 那个位置自然消失。

   旧的三个主题名 (light / dark / warm) 仍然读得回来, 见 LEGACY_ALIASES ——
   已经选过"暖色"的人不该因为这次改版被弹回默认主题。 */

import { EVENTS, emit, on } from '../core/bus.js';

const THEME_KEY = 'eastudy.v3.theme';
const MODE_KEY = 'eastudy.v3.mode';

/** 12 套色系, 顺序即面板里的排列顺序。
 *  name 与 public/assets/themes-12.css 的块一一对应, 改一边必须改另一边。 */
export const THEMES = Object.freeze([
  { id: 'theme-01', name: '鼠尾草绿', note: '清新疗愈' },
  { id: 'theme-02', name: '柔雾蓝灰', note: '温柔知性' },
  { id: 'theme-03', name: '孔雀蓝绿', note: '优雅清透' },
  { id: 'theme-04', name: '香槟米杏', note: '柔和高级' },
  { id: 'theme-05', name: '岩茶棕灰', note: '轻奢成熟' },
  { id: 'theme-06', name: '海军蓝金', note: '经典精致' },
  { id: 'theme-07', name: '月光银蓝', note: '冷静高级' },
  { id: 'theme-08', name: '焦糖燕麦', note: '温柔质感' },
  { id: 'theme-09', name: '玉雾青灰', note: '清冷知性' },
  { id: 'theme-10', name: '橄榄奶茶', note: '轻熟柔和' },
  { id: 'theme-11', name: '雾霾蓝灰', note: '通勤经典' },
  { id: 'theme-12', name: '冰川青蓝', note: '清爽专业' },
]);

export const THEME_IDS = Object.freeze(THEMES.map((t) => t.id));
export const DEFAULT_THEME = 'theme-01';

/** 模式只有两个 —— 这是规范定死的 (data-mode="light|dark")。
 *  `system` 是**偏好**, 不是模式: 它先解析成两者之一再写进 DOM。 */
export const MODES = Object.freeze(['light', 'dark']);

/** 顶栏按钮的图标。按模式给, 不按色系给 —— 24 种色系各配一个图标没人认得出来,
 *  而"我现在是浅色还是深色"是用户唯一需要一眼确认的事。
 *  沿用旧名 sun / moon, 暖色的 flame 随旧主题一起退役。 */
const GLYPH = { light: 'sun', dark: 'moon' };

/** 旧主题名 → 新世界。做改版迁移用, 不是给新代码引用的。
 *  - light / dark 是旧的**模式**名, 直接当 mode 用, 色系落回默认;
 *  - warm 是旧的暖色主题, 映射到 08 焦糖燕麦 —— 它和旧 warm 一样是琥珀暖棕,
 *    而且在 12 套里本就属于暖色档。深色模式下它就是"夜间暖色"的继承者。 */
const LEGACY_ALIASES = {
  light: { theme: DEFAULT_THEME, mode: 'light' },
  dark: { theme: DEFAULT_THEME, mode: 'dark' },
  warm: { theme: 'theme-08', mode: 'dark' },
};

function systemPrefersDark() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 把存储里的东西解析成 { theme, mode, preference }。
 *  preference 是"用户有没有明确选过模式": 'system' 表示跟着系统走。 */
function parseStored(themeRaw, modeRaw) {
  const theme = THEME_IDS.includes(themeRaw) ? themeRaw : null;
  const mode = MODES.includes(modeRaw) ? modeRaw : null;

  if (theme || mode) {
    return { theme: theme ?? DEFAULT_THEME, mode, preference: mode ?? 'system' };
  }

  // 旧版本存下来的名字
  const legacy = LEGACY_ALIASES[themeRaw];
  if (legacy) return { ...legacy, preference: legacy.mode };

  return { theme: DEFAULT_THEME, mode: null, preference: 'system' };
}

export function resolveMode(preference) {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return MODES.includes(preference) ? preference : 'light';
}

/* 旧签名保留: 老代码与老测试调 resolveTheme('system') 期望拿回一个主题名。
   现在"主题名"这个概念拆成了两半, 这里按旧语义返回**模式**, 因为旧的三套
   里 light/dark/warm 的差异主要就是明暗。新代码请用 resolveMode。 */
export function resolveTheme(preference) {
  return resolveMode(preference);
}

export function createThemeController({ initial = null, initialMode = null } = {}) {
  const storedTheme = initial ?? read(THEME_KEY);
  const storedMode = initialMode ?? read(MODE_KEY);
  const parsed = parseStored(storedTheme, storedMode);

  let themeId = THEME_IDS.includes(initial) ? initial : parsed.theme;
  let preference = initialMode && MODES.includes(initialMode) ? initialMode : parsed.preference;
  let mode = resolveMode(preference);

  function apply() {
    mode = resolveMode(preference);
    const root = document.documentElement;
    root.dataset.theme = themeId;
    root.dataset.mode = mode;
    root.dataset.themePreference = preference;
    /* 浏览器用这个画表单控件和滚动条。必须是**解析后**的浅深, 不能写 system,
       否则滚条会停在浅色而页面已经是深色。 */
    root.style.colorScheme = mode;
    emit(EVENTS.THEME_CHANGED, { theme: themeId, mode, preference });
  }

  function read(key) {
    try {
      const value = localStorage.getItem(key);
      return value || null;
    } catch { return null; }
  }

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 无痕模式 */ }
  }

  if (typeof matchMedia === 'function') {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const listener = () => { if (preference === 'system') apply(); };
    query.addEventListener?.('change', listener);
  }

  /* 内部动作写成闭包而不是对象上的方法:
     调用点会把 `theme.toggle` 拆下来递给事件监听器, 那样 this 就丢了。
     这三行在别处已经踩过一次, 不值得再踩。 */

  /** 选一套色系。保留当前模式 —— 换色系不该顺手把用户翻到深色。 */
  function setTheme(next) {
    if (!THEME_IDS.includes(next) || next === themeId) return;
    themeId = next;
    store(THEME_KEY, next);
    apply();
  }

  /** 选一个模式。'system' 是合法的, 表示交还给系统。 */
  function setMode(next) {
    if (next !== 'system' && !MODES.includes(next)) return;
    preference = next;
    store(MODE_KEY, next);
    apply();
  }

  /** 旧 API: set('light'|'dark'|'warm')。老调用点还能用, 语义见 LEGACY_ALIASES。 */
  function set(next) {
    if (MODES.includes(next) || next === 'system') return setMode(next);
    if (THEME_IDS.includes(next)) return setTheme(next);
    const legacy = LEGACY_ALIASES[next];
    if (!legacy) return;
    themeId = legacy.theme;
    preference = legacy.mode;
    store(THEME_KEY, themeId);
    store(MODE_KEY, preference);
    apply();
  }

  /** 单击: 翻面。这是顶栏那颗按钮唯一保证要做的事 ——
   *  **一次点击必须改变屏幕**。from 取的是屏幕上实际显示的模式, 而不是
   *  偏好: 偏好在 'system' 时不等于任何一边, 拿它去翻面会在系统深色时
   *  把第一击落到 dark 上, 屏幕纹丝不动, 用户以为按钮坏了。 */
  function toggle() {
    const next = mode === 'dark' ? 'light' : 'dark';
    setMode(next);
    return next;
  }

  apply();

  return {
    get theme() { return themeId; },
    get mode() { return mode; },
    get preference() { return preference; },
    /* 旧调用点读 `.resolved` 拿"屏幕上那套外观"。现在最接近的等价物是 mode,
       保留它是为了让 layout / account 那些还没改过来的引用不至于拿到 undefined。 */
    get resolved() { return mode; },
    get glyph() { return GLYPH[mode] ?? 'sun'; },
    setTheme,
    setMode,
    set,
    toggle,
    onChange(fn) { return on(EVENTS.THEME_CHANGED, fn); },
  };
}

/** 12 套面板用: 每套的两个模式各出一个代表色, 给色卡当预览用。
 *  这里**不写死色值** —— 面板渲染时把 data-theme / data-mode 临时挂到
 *  documentElement 上, 用 getComputedStyle 读回来。理由和 dist/preview.js
 *  里那段注释一样: 抄一遍色值, 面板描述的就是"我手边这一屏"而不是产品,
 *  以后改了 themes-12.css 两面就对不上了。 */
export function readThemeSwatches() {
  const root = document.documentElement;
  const keepTheme = root.dataset.theme;
  const keepMode = root.dataset.mode;
  const out = [];
  for (const t of THEMES) {
    const entry = { id: t.id, name: t.name, note: t.note, light: {}, dark: {} };
    for (const m of MODES) {
      root.dataset.theme = t.id;
      root.dataset.mode = m;
      const cs = getComputedStyle(root);
      entry[m] = {
        page: cs.getPropertyValue('--page-bg').trim(),
        card: cs.getPropertyValue('--card-bg').trim(),
        primary: cs.getPropertyValue('--primary').trim(),
        highlight: cs.getPropertyValue('--highlight').trim(),
      };
    }
    out.push(entry);
  }
  if (keepTheme === undefined) delete root.dataset.theme; else root.dataset.theme = keepTheme;
  if (keepMode === undefined) delete root.dataset.mode; else root.dataset.mode = keepMode;
  return out;
}

export { GLYPH as THEME_GLYPH };

/** 顶栏单击的循环: 两个模式。保留这个导出是因为旧测试按名字引用它,
 *  而它表达的事实仍然成立 —— 循环里没有 system。 */
export const THEME_CYCLE = MODES;

/** The player is always a dark-surface regardless of the page theme: on a light
    theme a bright video frame next to a bright page washes out the subtitles,
    and the fog-blue teaching colours were tuned against a dark surface.

    12 主题之后这条仍然成立, 但**主色不再锁死** —— 面锁深, 色跟主题。见
    themes-12.css 末尾 .player-surface 那一段。 */
export function lockPlayerSurface(node) {
  node.classList.add('player-surface');
  return () => node.classList.remove('player-surface');
}
