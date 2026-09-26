/* Exercises `src/ui/theme.js` — 12 套色系 × 浅深两版, 以及顶栏按钮做了什么。

   Why this file exists:

   外观由**两个正交属性**决定 (data-theme / data-mode), 而顶栏只有一颗按钮。
   这个不对称里藏着这条规则, 说得清, 但很容易做错:

     **每一次点击都必须让屏幕发生变化。**

   跟随系统的人正是会踩中的那一类。系统已经是深色, 他屏幕上就是深色; 如果
   翻面时拿"偏好"去翻, 偏好是 'system' 不等于任何一边, 朴素写法会从 dark
   迈到 light —— 这一下是对的。但换成"把 system 当成第三边"的实现, 第一击
   就会落到他正在看的那个模式上, 屏幕纹丝不动。测试里 system-dark 和
   system-light 两边都要钉, 因为后者会**碰巧通过**, 而它正是能抓住"修一个
   坏掉另一个"的那个用例。

   第二条被钉死的规则: 按钮画出来的图标必须和屏幕上的模式一致。两个模式两
   个图标, 一一对应, 不存在"两个状态穿同一件衣服"。

   第三条: 12 套色系的 id 必须与 themes-12.css 里实际存在的块严格一致。这条
   用一个真正去读 CSS 的测试守着, 不是在测试文件里再抄一份名单 —— 抄一份名
   单, 两边一起错就永远测不出来, 而 typo 的后果是整站没有颜色。

   这里的 DOM 是桩, 不是 dom.test.mjs 里那套 shim —— `theme.js` 只碰
   documentElement.dataset / style 和 matchMedia, 再多的就是给空气搭架子。
   桩用精确字符串匹配而不用正则: 宽松的匹配器会连 `(prefers-color-scheme)`
   或 `dark-mode` 一起放行, 真实 Firefox 停在浅色而测试全绿。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/* --- the stub ------------------------------------------------------------- */

const store = new Map();
let prefersDark = false;

globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

globalThis.document = {
  documentElement: { dataset: {}, style: {} },
};

globalThis.matchMedia = (query) => ({
  matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
  addEventListener() {},
  removeEventListener() {},
});

const {
  createThemeController, resolveTheme, resolveMode,
  THEME_CYCLE, THEME_GLYPH, THEMES, THEME_IDS, MODES, DEFAULT_THEME,
} = await import(pathToFileURL(join(root, 'src/ui/theme.js')).href);

/** 建一个控制器, 存储里预置 { theme, mode }。 */
function fresh(seed = {}) {
  store.clear();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k === 'theme' ? 'eastudy.v3.theme' : 'eastudy.v3.mode', v);
  }
  return createThemeController();
}

const onTheme = () => document.documentElement.dataset.theme;
const onMode = () => document.documentElement.dataset.mode;

/* --- 12 套的名单必须和 CSS 对得上 ----------------------------------------- */

test('THEMES 与 themes-12.css 里实际存在的块一一对应', () => {
  const css = readFileSync(join(root, 'public/assets/themes-12.css'), 'utf8');
  const declared = new Set([...css.matchAll(/\[data-theme="(theme-\d+)"\]/g)].map((m) => m[1]));
  for (const id of THEME_IDS) {
    assert.ok(declared.has(id), `themes-12.css 里没有 ${id} 的块 —— 选了它整站会没有颜色`);
  }
  assert.equal(declared.size, THEME_IDS.length,
    `CSS 里有 ${declared.size} 套、代码里认 ${THEME_IDS.length} 套, 两边对不上`);
  assert.equal(THEME_IDS.length, 12, '规范定的就是 12 套');
});

test('每套色系都同时有浅色块和深色块', () => {
  const css = readFileSync(join(root, 'public/assets/themes-12.css'), 'utf8');
  for (const id of THEME_IDS) {
    for (const mode of MODES) {
      assert.ok(
        css.includes(`[data-theme="${id}"][data-mode="${mode}"]`),
        `${id} 缺 ${mode} 版`,
      );
    }
  }
});

test('没有两套重名 —— 面板里两个"鼠尾草绿"用户没法区分', () => {
  const names = THEMES.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, `重名了:${names.join(', ')}`);
  assert.ok(THEMES.every((t) => t.id && t.name && t.note), '有主题缺 id / name / note');
});

/* --- 翻面 ----------------------------------------------------------------- */

test('单击一次翻面, 再单击翻回来', () => {
  const theme = fresh({ mode: 'light' });
  assert.equal(theme.toggle(), 'dark');
  assert.equal(onMode(), 'dark');
  assert.equal(theme.toggle(), 'light');
  assert.equal(onMode(), 'light');
});

test('每次 toggle 都真的改了屏幕上显示的明暗', () => {
  const theme = fresh({ mode: 'light' });
  let seen = onMode();
  for (let i = 0; i < 6; i += 1) {
    theme.toggle();
    assert.notEqual(onMode(), seen, `第 ${i + 1} 次点击屏幕没变`);
    seen = onMode();
  }
});

test('翻面不动色系 —— 换明暗不该顺手换掉用户挑的颜色', () => {
  const theme = fresh({ theme: 'theme-06', mode: 'light' });
  theme.toggle();
  assert.equal(onTheme(), 'theme-06');
  theme.toggle();
  assert.equal(onTheme(), 'theme-06');
});

test('循环里没有 system —— 那是偏好, 不是屏幕上的一种外观', () => {
  assert.ok(!THEME_CYCLE.includes('system'), `循环里混进了 system:${THEME_CYCLE.join(' → ')}`);
  assert.equal(THEME_CYCLE.length, 2, '循环应当正好是浅、深两版');
  assert.deepEqual([...THEME_CYCLE], ['light', 'dark']);
});

/* --- 反直觉的那一条 ------------------------------------------------------- */

test('跟随系统 + 系统深色:第一击必须变亮, 而不是原地不动', () => {
  prefersDark = true;
  const theme = fresh();          // 什么都没存 → 跟随系统
  assert.equal(theme.preference, 'system');
  assert.equal(theme.resolved, 'dark', '前提:系统深色时应当解析成 dark');
  assert.equal(onMode(), 'dark', '前提:屏幕现在就是深色');

  /* 把 system 当成第三边、从它出发去翻的实现会在这里返回 'dark' —— 用户点的
     那一下什么都看不到。屏幕上实际的下一站是 light。 */
  assert.equal(theme.toggle(), 'light');
  assert.equal(onMode(), 'light', '点击后必须和点击前不同');
  assert.equal(theme.preference, 'light', '点过之后偏好就从 system 变成了具体模式');
  prefersDark = false;
});

test('跟随系统 + 系统浅色:第一击走到深色', () => {
  prefersDark = false;
  const theme = fresh();
  assert.equal(theme.resolved, 'light');
  assert.equal(theme.toggle(), 'dark');
  assert.equal(onMode(), 'dark');
});

test('无论起点是什么, 一次点击一定改变屏幕 —— 这是唯一的硬约束', () => {
  const starts = [{}, { mode: 'light' }, { mode: 'dark' }, { theme: 'theme-12' },
    { theme: 'theme-03', mode: 'dark' }];
  for (const seed of starts) {
    for (const systemDark of [true, false]) {
      for (const legacy of [false, true]) {
        prefersDark = systemDark;
        store.clear();
        if (legacy && !seed.theme) store.set('eastudy.v3.theme', 'warm');
        for (const [k, v] of Object.entries(seed)) {
          store.set(k === 'theme' ? 'eastudy.v3.theme' : 'eastudy.v3.mode', v);
        }
        const theme = createThemeController();
        const before = onMode();
        theme.toggle();
        assert.notEqual(
          onMode(), before,
          `起点 ${JSON.stringify(seed)}(系统${systemDark ? '深' : '浅'}色)点击后屏幕没变`,
        );
      }
    }
  }
  prefersDark = false;
});

test('跟随系统起步时不会在翻面里绕回 system', () => {
  prefersDark = true;
  const theme = fresh();
  for (let i = 0; i < 6; i += 1) {
    theme.toggle();
    assert.notEqual(theme.preference, 'system', '点击不该把用户送回跟随系统');
  }
  prefersDark = false;
});

/* --- 图标跟模式, 不跟色系 ------------------------------------------------- */

test('两个模式各有各的图标, 没有两个共用同一个', () => {
  const glyphs = MODES.map((name) => THEME_GLYPH[name]);
  assert.ok(glyphs.every(Boolean), '有模式没配图标');
  assert.equal(new Set(glyphs).size, glyphs.length, `图标重复了:${glyphs.join(', ')}`);
});

test('切换之后 glyph 跟着屏幕上的模式走', () => {
  const theme = fresh({ mode: 'light' });
  assert.equal(theme.glyph, THEME_GLYPH.light);
  theme.toggle();
  assert.equal(theme.glyph, THEME_GLYPH[onMode()]);
  theme.toggle();
  assert.equal(theme.glyph, THEME_GLYPH.light);
});

test('换色系之后 glyph 不变 —— 图标表达的是明暗, 不是颜色', () => {
  const theme = fresh({ theme: 'theme-01', mode: 'dark' });
  const before = theme.glyph;
  theme.setTheme('theme-11');
  assert.equal(theme.glyph, before);
});

/* --- 选色系 ----------------------------------------------------------------- */

test('setTheme 换色系并记住, 模式原地不动', () => {
  const theme = fresh({ mode: 'dark' });
  theme.setTheme('theme-07');
  assert.equal(onTheme(), 'theme-07');
  assert.equal(onMode(), 'dark', '换色系不该顺手翻明暗');
  assert.equal(store.get('eastudy.v3.theme'), 'theme-07');
});

test('setTheme 拒绝不认识的名字, 屏幕一点不动', () => {
  const theme = fresh({ theme: 'theme-02', mode: 'light' });
  theme.setTheme('theme-13');
  theme.setTheme('');
  theme.setTheme(null);
  assert.equal(onTheme(), 'theme-02');
  assert.equal(onMode(), 'light');
});

test('setMode 接受 system, 并真的交还给系统', () => {
  prefersDark = true;
  const theme = fresh({ mode: 'light' });
  theme.setMode('system');
  assert.equal(theme.preference, 'system');
  assert.equal(onMode(), 'dark', '交还系统后应当跟着系统变深');
  assert.equal(store.get('eastudy.v3.mode'), 'system');
  prefersDark = false;
});

test('setMode 拒绝第三模式 —— 规范里只有 light / dark', () => {
  const theme = fresh({ mode: 'light' });
  theme.setMode('sepia');
  assert.equal(onMode(), 'light');
  assert.equal(theme.preference, 'light');
});

/* --- 持久化与降级 --------------------------------------------------------- */

test('两半都被记住:重开控制器后还是同一套色系 + 同一个模式', () => {
  const first = fresh({ theme: 'theme-09', mode: 'light' });
  first.toggle();
  assert.equal(first.theme, 'theme-09');
  assert.equal(first.mode, 'dark');

  const second = createThemeController();
  assert.equal(second.theme, 'theme-09', '色系没有被读回来');
  assert.equal(second.mode, 'dark', '模式没有被读回来');
  assert.equal(onTheme(), 'theme-09');
  assert.equal(onMode(), 'dark');
});

test('只存了色系时, 模式退回跟随系统而不是硬编码浅色', () => {
  prefersDark = true;
  const theme = fresh({ theme: 'theme-05' });
  assert.equal(theme.theme, 'theme-05');
  assert.equal(theme.preference, 'system');
  assert.equal(onMode(), 'dark');
  prefersDark = false;
});

test('存储里是垃圾值时退回默认, 而不是把垃圾写进 DOM', () => {
  const theme = fresh({ theme: 'solarized', mode: 'sepia' });
  assert.equal(theme.theme, DEFAULT_THEME);
  assert.equal(theme.preference, 'system');
  assert.equal(onTheme(), DEFAULT_THEME);
});

test('老的 warm 偏好映射到 08 焦糖燕麦深色, 而不是被丢掉', () => {
  store.clear();
  store.set('eastudy.v3.theme', 'warm');
  const theme = createThemeController();
  assert.equal(theme.theme, 'theme-08', '旧用户不该被弹回默认主题');
  assert.equal(theme.mode, 'dark');
});

test('老的 light / dark 偏好各自接住', () => {
  assert.equal(fresh({ theme: 'light' }).mode, 'light');
  assert.equal(fresh({ theme: 'dark' }).mode, 'dark');
});

test('set() 仍然认识旧名字, 也认识新名字', () => {
  const theme = fresh({ mode: 'light' });
  theme.set('warm');
  assert.equal(theme.theme, 'theme-08');
  theme.set('theme-02');
  assert.equal(theme.theme, 'theme-02');
  theme.set('dark');
  assert.equal(theme.mode, 'dark');
  theme.set('solarized');
  assert.equal(theme.mode, 'dark', '非法值不该改动任何东西');
});

/* --- 解析函数本身 --------------------------------------------------------- */

test('resolveMode 单独看也对', () => {
  prefersDark = true;
  assert.equal(resolveMode('system'), 'dark');
  prefersDark = false;
  assert.equal(resolveMode('system'), 'light');
  assert.equal(resolveMode('dark'), 'dark', 'dark 不受系统偏好影响');
  assert.equal(resolveMode(undefined), 'light');
  assert.equal(resolveMode('sepia'), 'light');
});

test('resolveTheme 保留了旧签名, 行为与 resolveMode 一致', () => {
  prefersDark = true;
  assert.equal(resolveTheme('system'), 'dark');
  prefersDark = false;
  assert.equal(resolveTheme(undefined), 'light');
  assert.equal(resolveTheme('dark'), 'dark');
});

test('colorScheme 写的是解析后的浅深, 不是 system', () => {
  prefersDark = true;
  const theme = fresh();
  assert.equal(document.documentElement.style.colorScheme, 'dark',
    '写 system 会让滚动条停在浅色而页面已经是深色');
  theme.toggle();
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.equal(document.documentElement.dataset.themePreference, 'light');
  prefersDark = false;
});
