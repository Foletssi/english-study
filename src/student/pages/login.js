/* Eastudy V3 — 登录页.

   Phone number plus password. The legacy exposed an email form because the
   backend stores phone numbers as synthetic emails, and it leaked that detail
   into the UI. Here the learner types a phone number and never sees the
   mapping.

   The layout is the two-panel split: brand panel on the left, form on the
   right, collapsing to a single column under 860px. */

import { el, mount, setText } from '../../core/dom.js';
import { textField } from '../../ui/field.js';
import { describeError } from '../../services/index.js';

export function createLoginPage({ auth, onAuthenticated, productName = 'Eastudy' }) {
  const phone = textField({
    name: 'phone',
    label: '手机号',
    type: 'tel',
    placeholder: '11 位手机号',
    autofocus: true,
    required: true,
  });
  const password = textField({
    name: 'password',
    label: '密码',
    type: 'password',
    placeholder: '登录密码',
    required: true,
  });

  const message = el('p', { class: 'login__message', hidden: true, role: 'alert' });

  const submit = el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, '登录');

  const form = el('form', {
    class: 'login__form',
    on: {
      submit: async (event) => {
        event.preventDefault();
        setText(message, '');
        message.hidden = true;
        phone.setError('');
        password.setError('');

        if (!phone.value) { phone.setError('请输入手机号'); return; }
        if (!password.value) { password.setError('请输入密码'); return; }

        submit.disabled = true;
        setText(submit, '登录中…');
        try {
          // `signInWithPassword(phone, password)` takes two arguments and
          // throws on failure — it never resolves with `{ error }`. Passing a
          // single object put the literal string "[object Object]" through
          // `normalizePhone`, which stripped every non-digit, found nothing,
          // and rejected the sign-in as "请输入 11 位手机号。" — so a correct
          // phone number and password were refused, and the message blamed the
          // field the user had just filled in correctly.
          const session = await auth.signInWithPassword(phone.value, password.value);
          await onAuthenticated?.(session);
        } catch (error) {
          setText(message, describeError(error));
          message.hidden = false;
        } finally {
          submit.disabled = false;
          setText(submit, '登录');
        }
      },
    },
  },
    el('h1', { class: 'login__title' }, '登录'),
    el('p', { class: 'login__subtitle' }, '使用手机号登录,继续你的学习。'),
    phone.root,
    password.root,
    message,
    submit,
  );

  const root = el('div', { class: 'login' },
    el('aside', { class: 'login__brand' },
      el('div', { class: 'login__brand-inner' },
        el('span', { class: 'login__logo', 'aria-hidden': 'true' }, 'E'),
        el('p', { class: 'login__brand-name' }, productName),
        el('p', { class: 'login__brand-tagline' }, '英语视频学习'),
      ),
    ),
    el('main', { class: 'login__panel' }, form),
  );

  return { root, mount() { phone.focus(); }, unmount() {} };
}
