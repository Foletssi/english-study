/* Eastudy V3 — modal dialog.

   Built on <dialog> so the browser gives us focus trapping, Escape handling
   and the top-layer stacking for free. The legacy hand-rolled all three and
   got the focus trap wrong in two of its four modals. */

import { el, mount } from '../core/dom.js';

export function openModal({
  title,
  body,
  actions = [],
  size = 'md',
  dismissible = true,
  onClose,
} = {}) {
  const dialog = el('dialog', { class: `modal modal--${size}` });
  const closeButton = el('button', {
    class: 'modal__close',
    type: 'button',
    'aria-label': '关闭',
    on: { click: () => close('dismiss') },
  }, '×');

  const footer = actions.length
    ? el('footer', { class: 'modal__footer' },
        ...actions.map((action) => el('button', {
          class: `btn ${action.variant ? `btn--${action.variant}` : 'btn--ghost'}`,
          type: 'button',
          disabled: action.disabled || undefined,
          on: { click: async () => {
            const result = await action.run?.();
            if (result !== false) close('action');
          } },
        }, action.label)))
    : null;

  mount(dialog,
    el('header', { class: 'modal__head' },
      el('h2', { class: 'modal__title' }, title || ''),
      dismissible ? closeButton : null,
    ),
    el('div', { class: 'modal__body' }, body || ''),
    footer,
  );

  function onCancel(event) {
    if (!dismissible) { event.preventDefault(); return; }
    event.preventDefault();
    close('cancel');
  }

  function close(reason) {
    dialog.removeEventListener('cancel', onCancel);
    dialog.close();
    dialog.remove();
    onClose?.(reason);
  }

  dialog.addEventListener('cancel', onCancel);
  document.body.appendChild(dialog);
  dialog.showModal();

  // Autofocus the first meaningful control rather than the close button.
  const focusTarget = dialog.querySelector('[data-autofocus]')
    || dialog.querySelector('input, textarea, select')
    || dialog.querySelector('.modal__footer .btn');
  focusTarget?.focus();

  return {
    dialog,
    close,
    setBody(node) { mount(dialog.querySelector('.modal__body'), node); },
  };
}

/** Destructive confirmation. Returns a promise resolving to true/false so the
    caller reads like `if (!await confirm({...})) return;`. */
export function confirm({ title, message, confirmLabel = '确认', cancelLabel = '取消', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const modal = openModal({
      title,
      size: 'sm',
      body: el('p', { class: 'modal__message' }, message),
      actions: [
        { label: cancelLabel, run: () => { answered = true; resolve(false); } },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', run: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
    return modal;
  });
}

/** Prompt for a single value. Resolves to the string, or null if cancelled. */
export function prompt({ title, label, value = '', placeholder = '', confirmLabel = '确定', multiline = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const input = multiline
      ? el('textarea', { class: 'input', rows: '6', placeholder, 'data-autofocus': 'true' }, value)
      : el('input', { class: 'input', type: 'text', value, placeholder, 'data-autofocus': 'true' });

    const modal = openModal({
      title,
      size: 'sm',
      body: el('label', { class: 'field' }, el('span', { class: 'field__label' }, label), input),
      actions: [
        { label: '取消', run: () => { answered = true; resolve(null); } },
        { label: confirmLabel, variant: 'primary', run: () => { answered = true; resolve(input.value.trim()); } },
      ],
      onClose: () => { if (!answered) resolve(null); },
    });
    void modal;
  });
}
