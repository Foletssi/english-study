/* Eastudy V3 — form field helpers.

   Every field returns { root, get value, set value, focus } so a page can
   assemble a form without reaching into the DOM, and so validation errors have
   one place to render. */

import { el, setText } from '../core/dom.js';

export function textField({ name, label, value = '', placeholder = '', type = 'text', hint = '', required = false, autofocus = false }) {
  const input = el('input', {
    class: 'input', type, value, placeholder, name, id: `f-${name}`,
    required: required || undefined,
    'data-autofocus': autofocus ? 'true' : undefined,
  });
  const error = el('p', { class: 'field__error', hidden: true });
  const root = el('div', { class: 'field' },
    el('label', { class: 'field__label', for: `f-${name}` }, label, required ? el('span', { class: 'field__req' }, '*') : null),
    input,
    hint ? el('p', { class: 'field__hint' }, hint) : null,
    error,
  );
  return {
    root, input,
    get value() { return input.value.trim(); },
    set value(next) { input.value = next ?? ''; },
    setError(message) { setText(error, message); error.hidden = !message; },
    focus() { input.focus(); },
  };
}

export function textAreaField({ name, label, value = '', rows = 4, placeholder = '', hint = '' }) {
  const input = el('textarea', { class: 'input', rows: String(rows), placeholder, name, id: `f-${name}` }, value);
  const root = el('div', { class: 'field' },
    el('label', { class: 'field__label', for: `f-${name}` }, label),
    input,
    hint ? el('p', { class: 'field__hint' }, hint) : null,
  );
  return {
    root,
    get value() { return input.value.trim(); },
    set value(next) { input.value = next ?? ''; },
    focus() { input.focus(); },
  };
}

export function selectField({ name, label, value = '', options = [], hint = '' }) {
  const select = el('select', { class: 'input', name, id: `f-${name}` },
    ...options.map((option) => el('option', {
      value: option.value,
      selected: String(option.value) === String(value) || undefined,
    }, option.label)),
  );
  const root = el('div', { class: 'field' },
    el('label', { class: 'field__label', for: `f-${name}` }, label),
    select,
    hint ? el('p', { class: 'field__hint' }, hint) : null,
  );
  return {
    root,
    get value() { return select.value; },
    set value(next) { select.value = next; },
    focus() { select.focus(); },
    /* 让调用方不必知道 select 在 root 的第几个子节点里 —— 那是本模块的
       内部结构, 从这里漏出去之后, 任何一次改布局都会静默打断外面的监听. */
    onChange(fn) { select.addEventListener('change', fn); },
  };
}

export function checkboxField({ name, label, checked = false, hint = '' }) {
  const input = el('input', { class: 'checkbox', type: 'checkbox', name, id: `f-${name}`, checked: checked || undefined });
  const root = el('div', { class: 'field field--inline' },
    el('label', { class: 'field__check', for: `f-${name}` }, input, el('span', null, label)),
    hint ? el('p', { class: 'field__hint' }, hint) : null,
  );
  return {
    root,
    get value() { return input.checked; },
    set value(next) { input.checked = Boolean(next); },
    focus() { input.focus(); },
  };
}

export function formRow(...children) {
  return el('div', { class: 'form-row' }, ...children.filter(Boolean));
}

export function formGrid(...children) {
  return el('div', { class: 'form-grid' }, ...children.filter(Boolean));
}
