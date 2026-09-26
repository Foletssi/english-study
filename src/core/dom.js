/* Eastudy V3 — DOM construction helpers.

   The legacy app reached for innerHTML string building in hundreds of places,
   which made "is this string user content?" a per-call-site judgement and XSS
   a permanent background risk. V3 builds elements instead: text is set as
   text, and the only way to inject markup is an explicit, greppable opt-in. */

const HTML_PROP = Symbol('eastudy.html');

/* Children are VARIADIC, not a single slot: every call site in this codebase
   writes `el('header', { class: 'topbar' }, brand, navLinks, right)`. The
   signature used to be `(tag, props, children)` with one slot, so the fourth
   argument onward was dropped on the floor — silently, because a JS call with
   too many arguments is not an error. Every container in the app therefore
   rendered only its first child: the student shell kept its top bar and lost
   its outlet and tab bar, the top bar kept its brand and lost its nav, and the
   login form kept its title and lost its fields.

   It read as "the app renders but the page is blank": the router's container
   was a detached `<main>`, so pages mounted, their fetches fired, and none of
   it was ever in the document. Passing an array as the third argument still
   works — `append` flattens arrays — so both shapes are accepted. */
export function el(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props) apply(node, props);
  append(node, children);
  return node;
}

/** Explicit markup opt-in. Only ever used with static, code-owned strings. */
export function raw(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html);
  return template.content;
}

export function frag(children) {
  const fragment = document.createDocumentFragment();
  append(fragment, children);
  return fragment;
}

export function text(value) {
  return document.createTextNode(value == null ? '' : String(value));
}

export function append(parent, children) {
  if (children == null || children === false) return parent;
  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return parent;
  }
  if (children instanceof Node) { parent.appendChild(children); return parent; }
  if (children instanceof DocumentFragment) { parent.appendChild(children); return parent; }
  if (typeof children === 'object' && children[HTML_PROP]) { parent.appendChild(children[HTML_PROP].cloneNode(true)); return parent; }
  parent.appendChild(text(children));
  return parent;
}

export function apply(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;

    if (key === 'html') {
      node.appendChild(raw(value));
    } else if (key === 'class' || key === 'className') {
      node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) {
        if (val == null) continue;
        if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
        else node.style[prop] = val;
      }
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) {
        if (val != null) node.dataset[prop] = String(val);
      }
    } else if (key === 'on' && typeof value === 'object') {
      for (const [event, handler] of Object.entries(value)) {
        if (typeof handler === 'function') node.addEventListener(event, handler);
      }
    } else if (key === 'ref' && typeof value === 'function') {
      value(node);
    } else if (key === 'value' && ('value' in node)) {
      node.value = value == null ? '' : value;
    } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') {
      node[key] = Boolean(value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(root, ...nodes) {
  clear(root);
  for (const node of nodes) append(root, node);
  return root;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/** Event delegation — one listener per container instead of one per row. */
export function delegate(root, eventName, selector, handler) {
  const listener = (event) => {
    const match = event.target instanceof Element ? event.target.closest(selector) : null;
    if (match && root.contains(match)) handler(event, match);
  };
  root.addEventListener(eventName, listener);
  return () => root.removeEventListener(eventName, listener);
}

/** Toggle a class and return the disposer, for view teardown lists. */
export function toggleClass(node, className, on) {
  node.classList.toggle(className, on);
  return () => node.classList.remove(className);
}

export function setText(node, value) {
  const next = value == null ? '' : String(value);
  if (node.textContent !== next) node.textContent = next;
  return node;
}
