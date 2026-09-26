/* Exercises `src/core/dom.js` and both layouts against a minimal DOM shim,
   running in Node with no browser.

   Why this file exists — the bug it was written after:

   `el()` used to be declared `(tag, props, children)` with a SINGLE children
   slot, while every one of the 302 call sites across 24 files wrote the
   variadic form `el('div', {...}, a, b, c)`. JavaScript does not error on a
   call with too many arguments, so the fourth argument onward was discarded
   silently and every container in the app rendered only its first child:

     - the student shell kept its top bar, lost its `#outlet` and tab bar
     - the top bar kept its brand, lost its nav links and right-hand buttons
     - the login form kept its `<h1>`, lost both input fields and the submit

   The visible symptom was the cruelest part. The router's `container` was a
   detached `<main>`, so pages really did mount: their `mount()` ran, their
   network requests fired, nothing threw. The app was working correctly into a
   node that had never been in the document, and the screen stayed blank with a
   clean console.

   No other test could see it. The contract tests read the route table; the
   syntax test parses files; neither constructs a page. The failure lived in
   the gap between "the call is valid JavaScript" and "the layout is what the
   author wrote", which is exactly the gap this file covers.

   The shim is deliberately small — text content, children, classList,
   setAttribute, addEventListener — because the thing under test is the
   composition rule, not the DOM. Anything the shim does not implement would
   throw and fail the test rather than pass quietly. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/* --------------------------------------------------------------------------
   Minimal DOM shim
   -------------------------------------------------------------------------- */

class ShimNode {
  constructor(name) {
    this.nodeName = String(name).toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.dataset = {};
    this._class = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    /* 不给 textContent 赋初值. 真 DOM 的 setter 会清空子节点再追加一个文本节点,
       而我这里的 setter 也照此实现 —— 于是构造函数里的一次赋值就让每个元素
       出生时自带一个空的幽灵文本子节点, 所有子节点计数统统 +1. `childNodes`
       已经是空数组, 而 getter 会把它拼成 '' , 什么都不用做. */
  }

  get className() { return this._class; }
  set className(next) { this._class = String(next); }

  get classList() {
    const read = () => this._class.split(/\s+/).filter(Boolean);
    const self = this;
    return {
      contains: (c) => read().includes(c),
      add: (c) => { if (!read().includes(c)) self._class = [...read(), c].join(' '); },
      remove: (c) => { self._class = read().filter((x) => x !== c).join(' '); },
      toggle: (c, on) => {
        const has = read().includes(c);
        const want = on === undefined ? !has : Boolean(on);
        if (want && !has) self._class = [...read(), c].join(' ');
        if (!want && has) self._class = read().filter((x) => x !== c).join(' ');
        return want;
      },
    };
  }

  appendChild(child) {
    if (child instanceof ShimFragment) {
      for (const inner of [...child.childNodes]) this.appendChild(inner);
      child.childNodes = [];
      return child;
    }
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((n) => n !== child);
    return child;
  }

  get firstChild() { return this.childNodes[0] ?? null; }

  replaceChildren(...next) {
    this.childNodes = [];
    for (const node of next) this.appendChild(node);
  }

  append(...next) { for (const node of next) this.appendChild(node); }

  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((child) => child instanceof ShimNode && child.contains(node));
  }

  /* Text content is derived from the subtree, which is what lets the
     assertions below read a rendered page the way a user would.

     The setter mirrors the real DOM: it replaces every child with a single text
     node rather than storing a string beside them. That distinction matters to
     `setText`, which is written as "write only if changed" and is therefore
     sensitive to a getter that disagrees with its own setter. */
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [];
    this.appendChild(new ShimText(value));
  }
}

/* Text nodes need their own class: their `textContent` is their data, not the
   concatenation of children they do not have. */
class ShimText extends ShimNode {
  constructor(value) { super('#text'); this._text = String(value); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

/* A fragment deliberately does NOT extend ShimNode.

   `append()` tests `children instanceof Node` before `instanceof
   DocumentFragment`, so only a fragment that is not a Node reaches the
   fragment branch. That ordering is invisible against a real DOM, where the
   array case is matched first and fragments are rare — but a shim whose
   fragment inherited from its Node would be devoured by the earlier branch and
   this file would end up measuring the shim instead of `dom.js`. Standing the
   class alone keeps `append` exercised exactly as the browser exercises it,
   without touching the production code to suit the test.

   The duplicate surface below is the cost: a fragment is only ever created,
   filled and handed to `appendChild`, so the five members it needs are spelled
   out rather than inherited. */
class ShimFragment {
  constructor() {
    this.nodeName = '#fragment';
    this.childNodes = [];
    this._text = '';
  }

  appendChild(child) {
    if (child instanceof ShimFragment) {
      for (const inner of [...child.childNodes]) this.appendChild(inner);
      child.childNodes = [];
      return child;
    }
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((n) => n !== child);
    return child;
  }

  get firstChild() { return this.childNodes[0] ?? null; }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }

  set textContent(value) {
    this.childNodes = [];
    this.appendChild(new ShimText(value));
  }
}

class ShimElement extends ShimNode {}

function installDom() {
  const document = {
    createElement: (tag) => (tag === 'template' ? makeTemplate() : new ShimElement(tag)),
    createTextNode: (value) => new ShimText(value),
    createDocumentFragment: () => new ShimFragment(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: new ShimElement('body'),
  };

  /* `raw()` builds through a <template>, so the shim needs one that exposes
     `.content` as a fragment. Nothing in these tests relies on parsed markup
     beyond that, and `raw` is only ever passed static strings. */
  function makeTemplate() {
    const tpl = new ShimElement('template');
    tpl.content = new ShimFragment();
    Object.defineProperty(tpl, 'innerHTML', {
      set(value) {
        const holder = new ShimElement('div');
        holder.textContent = String(value);
        tpl.content = new ShimFragment();
        tpl.content.appendChild(new ShimText(String(value)));
      },
      get() { return ''; },
    });
    return tpl;
  }

  globalThis.document = document;
  globalThis.Node = ShimNode;
  globalThis.DocumentFragment = ShimFragment;

  /* localStorage is read at module scope by the admin layout for the sidebar
     preference, and inside a try/catch — an absent one is fine, but providing
     it keeps the layout's happy path exercised rather than its fallback. */
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window = globalThis.window ?? {};

  return document;
}

installDom();

/* Imported after the shim exists: `dom.js` reads `document` at call time, but
   the layouts read `localStorage` while the module body runs. */
const dom = await import(pathToFileURL(join(root, 'src/core/dom.js')).href);
const { el, frag, text, append, mount, setText, clear } = dom;
const { createStudentLayout } = await import(pathToFileURL(join(root, 'src/student/layout.js')).href);
const { createAdminLayout } = await import(pathToFileURL(join(root, 'src/admin/layout.js')).href);

/** Count descendants whose class list contains `className`. */
function countByClass(node, className) {
  let total = node.className.split(/\s+/).includes(className) ? 1 : 0;
  for (const child of node.childNodes) {
    if (child instanceof ShimNode) total += countByClass(child, className);
  }
  return total;
}

/** Find the first descendant with `id`, or null. */
function findById(node, id) {
  if (node.getAttribute?.('id') === id) return node;
  for (const child of node.childNodes) {
    if (child instanceof ShimNode) {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Find the first descendant whose class list contains every named class. */
function findFirstByClass(node, ...classes) {
  const own = node.className.split(/\s+/);
  if (classes.every((name) => own.includes(name))) return node;
  for (const child of node.childNodes) {
    if (child instanceof ShimNode) {
      const found = findFirstByClass(child, ...classes);
      if (found) return found;
    }
  }
  return null;
}

/* --------------------------------------------------------------------------
   `el` — the composition rule
   -------------------------------------------------------------------------- */

test('el 保留全部子节点,而不是只保留第一个', () => {
  const node = el('header', { class: 'topbar' },
    el('a', { class: 'brand' }, 'E'),
    el('nav', { class: 'nav' }, 'x'),
    el('div', { class: 'right' }, 'y'),
  );

  assert.equal(node.childNodes.length, 3, '第 4 个参数起被丢弃了');
  assert.deepEqual(
    node.childNodes.map((n) => n.className),
    ['brand', 'nav', 'right'],
  );
});

test('el 子节点按书写顺序排列', () => {
  const node = el('ul', null,
    el('li', null, 'a'),
    el('li', null, 'b'),
    el('li', null, 'c'),
  );
  assert.deepEqual(node.childNodes.map((n) => n.textContent), ['a', 'b', 'c']);
});

test('el 的 props 为 null 时仍然接收子节点', () => {
  // `el('div', null, a, b)` is a real call shape in this codebase.
  const node = el('div', null, el('span', null, '1'), el('span', null, '2'));
  assert.equal(node.childNodes.length, 2);
});

test('el 接受数组形式的孩子,老写法不回归', () => {
  // `append` flattens arrays, so both shapes must keep working.
  const node = el('div', { class: 'row' }, [
    el('span', null, 'a'),
    el('span', null, 'b'),
  ]);
  assert.equal(node.childNodes.length, 2);
});

test('el 接受字符串孩子并转成文本节点', () => {
  const node = el('p', { class: 'note' }, '纯文本');
  assert.equal(node.textContent, '纯文本');
});

test('深度嵌套的三层结构完整保留', () => {
  // Mirrors the admin shell: el('div', {...}, sidebar, el('div', {...}, topbar,
  // outlet), scrim) — the shape whose middle layer a one-slot `el` erased.
  const node = el('div', { class: 'shell' },
    el('aside', { class: 'sidebar' }),
    el('div', { class: 'admin-main' },
      el('header', { class: 'admin-topbar' }),
      el('main', { class: 'outlet', id: 'outlet' }),
    ),
    el('div', { class: 'scrim' }),
  );

  assert.equal(node.childNodes.length, 3);
  assert.ok(findById(node, 'outlet'), '嵌套两层的 outlet 丢失了');
  assert.equal(node.childNodes[1].childNodes.length, 2);
});

test('append 的假值处理:null、false、undefined 不产生节点', () => {
  const node = el('div', null, null, false, undefined, el('span', null, 'x'));
  assert.equal(node.childNodes.length, 1);
});

test('el 的 hidden 属性写入 true 时不会渲染出可见元素', () => {
  // `apply` skips any prop whose value is `null` or `false`, which is how
  // `'aria-current': active ? 'page' : undefined` avoids a bogus attribute.
  const hidden = el('span', { hidden: true }, 'x');
  assert.equal(hidden.hidden, true);

  const shown = el('span', { 'aria-current': undefined }, 'x');
  assert.equal(shown.getAttribute('aria-current'), null);
});

test('mount 先清空再插入,重复调用不会累积', () => {
  const host = el('nav', { class: 'nav' });
  mount(host, el('a', null, '1'), el('a', null, '2'));
  assert.equal(host.childNodes.length, 2);
  mount(host, el('a', null, '3'));
  assert.equal(host.childNodes.length, 1);
  assert.equal(host.textContent, '3');
});

test('clear 与 setText 的行为', () => {
  const node = el('div', null, 'a', 'b');
  clear(node);
  assert.equal(node.childNodes.length, 0);
  setText(node, '重设');
  assert.equal(node.textContent, '重设');
  // A no-op write must not touch the DOM reference.
  const textNode = node.firstChild;
  setText(node, '重设');
  assert.equal(node.firstChild, textNode);
});

test('frag 与 text 的基础行为', () => {
  const fragment = frag([el('span', null, 'a'), el('span', null, 'b')]);
  assert.equal(fragment.childNodes.length, 2);
  assert.equal(text(7).textContent, '7');
  const host = el('div');
  append(host, fragment);
  assert.equal(host.childNodes.length, 2, 'document fragment 未展开');
});

/* --------------------------------------------------------------------------
   Layouts — the structures whose missing children blanked the screen
   -------------------------------------------------------------------------- */

function fakeSession(profile = null) {
  return { profile, isSignedIn: true, isAdmin: profile?.role === 'admin' };
}

function fakeTheme() {
  return { resolved: 'light', toggle() {} };
}

test('学员端外壳包含 outlet、顶栏导航与标签栏', () => {
  const layout = createStudentLayout({
    session: fakeSession(),
    theme: fakeTheme(),
    navigate() {},
  });

  assert.ok(layout.outlet, 'layout.outlet 未暴露');
  assert.ok(findById(layout.root, 'outlet'), '#outlet 不在外壳里 —— 路由器会挂到游离节点上');
  assert.equal(layout.root.className.split(/\s+/).includes('shell--student'), true);
  assert.equal(countByClass(layout.root, 'topbar__brand'), 1);
  // paintNav runs on every route change; before it runs the nav is empty by
  // design, so drive it the way the router does.
  layout.setRoute('/');
  assert.equal(countByClass(layout.root, 'topbar__link'), 5);
  assert.equal(countByClass(layout.root, 'tabbar__item'), 5);
  // Each tab item is icon + label: a single-slot `el` would have kept the icon.
  assert.equal(countByClass(layout.root, 'tabbar__icon'), 5);
  assert.equal(countByClass(layout.root, 'tabbar__label'), 5);
  assert.equal(countByClass(layout.root, 'topbar__icon-btn'), 2);
});

test('学员端外壳的导航高亮跟随当前路由', () => {
  const layout = createStudentLayout({ session: fakeSession(), theme: fakeTheme(), navigate() {} });
  layout.setRoute('/catalog');
  const active = [];
  (function walk(node) {
    if (node.className.split(/\s+/).includes('is-active')) active.push(node.textContent);
    for (const child of node.childNodes) if (child instanceof ShimNode) walk(child);
  })(layout.root);
  // One in the top bar and one in the tab bar. The tab item carries its icon
  // and its label as two spans — which is itself a check that both survived:
  // a single-slot `el` would have left the label off.
  //
  // 图标从字符换成了内联 SVG,所以这里不再断言 `▤视频库` 这种把图形混进
  // textContent 的字符串 —— 那种断言其实是把"图标是文本"这个实现细节钉死了,
  // 而且垫片里的 SVG 会被序列化成整段 markup,读起来完全不像在查高亮。
  // 改成分别断言两件事:选中项的文字标签对了,且它的图标确实是个 SVG 节点。
  assert.equal(active.length, 2, `期望顶栏与标签栏各一个高亮,实际 ${active.length} 个`);
  assert.ok(active[0].includes('视频库'), `顶栏高亮项的文字不对:${JSON.stringify(active[0])}`);
  assert.ok(active[1].includes('视频库'), `标签栏高亮项的文字不对:${JSON.stringify(active[1])}`);

  // 图标必须是内联 SVG,而不是退回成 `▤` 这样的字符.
  //
  // 这里查的是图标 span 的内容里有没有 `<svg` 与 `viewBox`,而不是查"有几个
  // svg 标签"—— 垫片里没有 HTML 解析器,`raw()` 的产物是一段文本节点,查标签
  // 只会永远得到 0,那测的是垫片而不是产品代码.`viewBox` 一起断言,是因为
  // 只查 `<svg` 的话,一个忘了写 viewBox 的图标照样能骗过测试,而那种图标在
  // 页面上会被当成 0×0 的空白.
  // 注意不能用 `findFirstByClass(root, 'is-active')` —— 顶栏链接也在遍历顺序里,
  // 而它在标签栏之前,所以那个调用拿到的是顶栏那一项. 这里要的是"同时是
  // 标签栏项、又高亮"的那个节点.
  const activeTab = findFirstByClass(layout.root, 'tabbar__item', 'is-active');
  assert.ok(activeTab, '标签栏里没有高亮项');
  const iconSpan = findFirstByClass(activeTab, 'tabbar__icon');
  assert.ok(iconSpan, '标签栏高亮项缺少图标 span');
  assert.ok(iconSpan.textContent.includes('<svg'), `图标不是 SVG:${JSON.stringify(iconSpan.textContent)}`);
  assert.ok(iconSpan.textContent.includes('viewBox'), '图标缺少 viewBox,会被渲染成空白');
});

test('控制端外壳包含 outlet 与侧边栏分组', () => {
  const layout = createAdminLayout({
    session: fakeSession({ role: 'admin', display_name: '张管理' }),
    theme: fakeTheme(),
    navigate() {},
  });

  assert.ok(findById(layout.root, 'outlet'), '#outlet 不在控制端外壳里');
  assert.equal(layout.root.className.split(/\s+/).includes('shell--admin'), true);
  layout.setRoute('/admin');
  assert.equal(countByClass(layout.root, 'sidebar__group'), 3);
  assert.equal(countByClass(layout.root, 'sidebar__group-label'), 3);
  // 总览 / 视频管理 / 处理队列 / 学员与邀请码 / 设置与健康
  assert.equal(countByClass(layout.root, 'sidebar__link'), 5);
  assert.equal(countByClass(layout.root, 'sidebar__label'), 5);
  // The signed-in operator's name reaches the top bar.
  assert.equal(countByClass(layout.root, 'admin-topbar__user'), 1);
});

test('两个外壳的 outlet 是同一棵子树里的独立节点', () => {
  // `layout.outlet` and the node inside `layout.root` must be the same object,
  // or the router mounts into a detached copy and the screen stays blank while
  // every request still fires.
  const student = createStudentLayout({ session: fakeSession(), theme: fakeTheme(), navigate() {} });
  assert.equal(findById(student.root, 'outlet'), student.outlet);

  const admin = createAdminLayout({ session: fakeSession(), theme: fakeTheme(), navigate() {} });
  assert.equal(findById(admin.root, 'outlet'), admin.outlet);
});
