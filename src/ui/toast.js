/* Eastudy V3 — transient notifications.

   One host element, one queue. The legacy had three separate toast helpers
   that could stack on top of each other in the same corner. */

import { el, mount } from '../core/dom.js';
import { EVENTS, on } from '../core/bus.js';

const VARIANTS = {
  info: { role: 'status', className: 'toast toast--info' },
  success: { role: 'status', className: 'toast toast--success' },
  warn: { role: 'alert', className: 'toast toast--warn' },
  error: { role: 'alert', className: 'toast toast--error' },
};

let host = null;
let unsubscribe = null;
const live = new Set();

function ensureHost() {
  if (host?.isConnected) return host;
  host = el('div', { class: 'toast-host', 'aria-live': 'polite', 'aria-atomic': 'false' });
  document.body.appendChild(host);
  return host;
}

export function toast(message, { variant = 'info', duration = 4000, action = null } = {}) {
  const spec = VARIANTS[variant] || VARIANTS.info;
  const node = el('div', { class: spec.className, role: spec.role });

  el('p', { class: 'toast__message' }, String(message)).parentNode;
  node.appendChild(el('p', { class: 'toast__message' }, String(message)));

  if (action) {
    node.appendChild(el('button', {
      class: 'toast__action',
      type: 'button',
      on: { click: () => { dismiss(); action.run(); } },
    }, action.label));
  }

  const close = el('button', {
    class: 'toast__close',
    type: 'button',
    'aria-label': '关闭提示',
    on: { click: () => dismiss() },
  }, '×');
  node.appendChild(close);

  ensureHost().appendChild(node);
  live.add(node);

  // Enter animation on the next frame so the transition actually runs.
  requestAnimationFrame(() => node.classList.add('is-visible'));

  let timer = duration > 0 ? setTimeout(dismiss, duration) : null;

  function dismiss() {
    if (!live.has(node)) return;
    live.delete(node);
    if (timer) { clearTimeout(timer); timer = null; }
    node.classList.remove('is-visible');
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  }

  node.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null; } });
  node.addEventListener('mouseleave', () => { if (duration > 0) timer = setTimeout(dismiss, 1500); });

  return dismiss;
}

/** Wire bus-emitted toasts so a service can report without importing the UI. */
export function attachToastBridge() {
  if (unsubscribe) return unsubscribe;
  unsubscribe = on(EVENTS.TOAST, (payload) => {
    if (typeof payload === 'string') toast(payload);
    else if (payload?.message) toast(payload.message, payload);
  });
  return unsubscribe;
}
