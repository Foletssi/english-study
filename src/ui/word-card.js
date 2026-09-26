/* Eastudy V3 — 词卡.

   点字幕里的重点词开这张卡。卡片回答三个问题, 顺序就是内容的顺序:

       这个词是什么   …… 词形 + 音标 + 词性胶囊
       什么意思       …… 核心释义
       在这句里怎么理解 …… 语境理解 + 例句(目标词高亮)

   发音按钮有四个状态(idle / loading / playing / retry), 对应设计稿底部
   那一排图示。为什么要有 retry 这个状态: 浏览器合成本身会失败 —— 没有
   英文语音包、音频设备被别的标签页占着、Chrome 在用户没交互过页面前
   拒绝朗读。这些都不是"加载中", 转圈转到天荒地老最伤人, 所以超时就退到
   "重试", 让用户知道该再点一下, 而不是以为页面死了。

   这是一个纯展示组件: 它不碰 service、不读全局状态。要播原句、要加生词本,
   由调用方通过回调接过去 —— 词卡不知道播放器长什么样, 播放器也不需要知道
   卡片上有什么按钮。 */

import { el, mount, setText } from '../core/dom.js';
import { icon } from './icons.js';
/* 发音的状态机跟字幕行上的喇叭是同一份(ui/speech.js)。这里只换措辞 ——
   卡片上的按钮读的是"这个词", 字幕行上的是"这一句"。 */
import { createSpeaker, SPEAK_LABEL as SHARED_SPEAK_LABEL } from './speech.js';

const SPEAK_LABEL = { ...SHARED_SPEAK_LABEL, idle: '朗读这个词' };

/* 词性/标签的中文名。库里存的是英文码, 直接显示 'idiom' 对学员没有意义。 */
const TAG_NAMES = {
  idiom: '习语',
  phrase: '短语',
  collocation: '搭配',
  slang: '俚语',
  verb: '动词',
  noun: '名词',
  adj: '形容词',
  adjective: '形容词',
  adv: '副词',
  adverb: '副词',
  prep: '介词',
  conj: '连词',
  pron: '代词',
  interj: '感叹词',
};

export function createWordCard({ onPlaySentence, onAdd, onFollow, onNotify } = {}) {
  let token = null;
  let sentence = null;
  let video = null;

  const wordText = el('h2', { class: 'word-card__word' });
  const phonetic = el('p', { class: 'word-card__phonetic' });
  const tag = el('span', { class: 'word-card__tag', hidden: true });

  const followButton = el('button', {
    class: 'word-card__icon-btn', type: 'button', 'aria-label': '关注这个词',
    title: '关注',
    on: { click: () => { if (token) onFollow?.({ token, sentence, video }); } },
  }, icon('star', { size: 20 }));

  const speakButton = el('button', {
    class: 'word-card__speak', type: 'button', 'data-state': 'idle',
    on: { click: () => speak() },
  });

  const closeButton = el('button', {
    class: 'word-card__icon-btn', type: 'button', 'aria-label': '关闭词卡',
    on: { click: () => hide() },
  }, icon('close', { size: 20 }));

  const glossText = el('p', { class: 'word-card__gloss' });
  const glossBlock = el('section', { class: 'word-card__block' },
    el('h3', { class: 'word-card__label' }, '核心释义'),
    glossText,
  );

  const contextText = el('p', { class: 'word-card__context' });
  const contextBlock = el('section', { class: 'word-card__block' },
    el('h3', { class: 'word-card__label' }, '语境理解'),
    contextText,
  );

  const exampleEn = el('p', { class: 'word-card__example-en' });
  const exampleZh = el('p', { class: 'word-card__example-zh' });
  const exampleBox = el('figure', { class: 'word-card__example' }, exampleEn, exampleZh);

  const playButton = action('play', '播放原句', () => {
    if (sentence) onPlaySentence?.(sentence, token);
  });
  const copyButton = action('copy', '复制', () => { copyExample(); });
  const addButton = action('bookmarkPlus', '加入生词本', () => {
    if (token) onAdd?.({ token, sentence, video });
  }, { primary: true });

  /* 手机上这张卡是从底部滑上来的面板, 顶上那道小横杠是"可以往下拖走"的通用
     记号。**它是按钮, 不是装饰**: 画一根不能拖的横杠就是骗人, 用户会去拉它,
     所以点一下等于收起。桌面端它是右栏里的普通卡片, 横杠由 CSS 隐藏, 收起
     仍然靠右上角的 ✕。 */
  const handle = el('button', {
    class: 'word-card__handle', type: 'button', 'aria-label': '收起词卡',
    on: { click: () => hide() },
  });

  const root = el('aside', {
    class: 'word-card',
    hidden: true,
    role: 'region',
    'aria-label': '词语释义',
  },
    handle,
    el('header', { class: 'word-card__head' },
      el('div', { class: 'word-card__ident' },
        wordText,
        phonetic,
        tag,
      ),
      el('div', { class: 'word-card__tools' }, followButton, speakButton, closeButton),
    ),
    el('hr', { class: 'word-card__rule' }),
    glossBlock,
    contextBlock,
    exampleBox,
    el('footer', { class: 'word-card__actions' }, playButton, copyButton, addButton),
  );

  setSpeakState('idle');

  // ------------------------------------------------------------------ 展示

  function show({ token: nextToken, sentence: nextSentence, video: nextVideo } = {}) {
    if (!nextToken) { hide(); return; }

    /* 换了一个词就把上一遍朗读掐掉 —— 否则点第二个词时, 第一个词的读音
       还在响, 用户听到的是两个词叠在一起。 */
    if (nextToken.text !== token?.text) speaker.stop();

    token = nextToken;
    sentence = nextSentence || null;
    video = nextVideo || null;

    setText(wordText, token.text || '');
    setText(phonetic, token.phonetic || '');
    phonetic.hidden = !token.phonetic;

    const tagName = tagNameOf(token);
    setText(tag, tagName);
    tag.hidden = !tagName;

    const gloss = token.gloss || token.meaning || '';
    setText(glossText, gloss || '暂无释义');
    glossBlock.hidden = false;

    const context = token.context || token.note || '';
    setText(contextText, context);
    contextBlock.hidden = !context;

    renderExample();

    // 已关注过的词把星星点亮 —— 否则用户会反复点, 以为第一次没生效。
    const following = Boolean(token.following);
    followButton.classList.toggle('is-on', following);
    followButton.setAttribute('aria-label', following ? '取消关注这个词' : '关注这个词');
    mount(followButton, icon(following ? 'starFilled' : 'star', { size: 20 }));

    root.hidden = false;
  }

  function hide() {
    speaker.stop();
    setSpeakState('idle');
    token = null;
    sentence = null;
    video = null;
    root.hidden = true;
  }

  function renderExample() {
    const text = sentence?.text || token?.example || '';
    if (!text) {
      exampleBox.hidden = true;
      return;
    }
    exampleBox.hidden = false;
    mount(exampleEn, highlight(text, token?.text));
    const zh = sentence?.translation || token?.exampleTranslation || '';
    setText(exampleZh, zh);
    exampleZh.hidden = !zh;
  }

  // ------------------------------------------------------------------ 复制

  async function copyExample() {
    const lines = [sentence?.text || token?.example || token?.text || ''];
    const zh = sentence?.translation || '';
    if (zh) lines.push(zh);
    const payload = lines.filter(Boolean).join('\n');
    if (!payload) return;

    const ok = await writeClipboard(payload);
    onNotify?.(ok ? '已复制例句' : '复制失败, 请手动选中', ok ? 'success' : 'error');
  }

  // ------------------------------------------------------------------ 发音

  /* 状态机在 ui/speech.js。这里唯一要交代的是"我怎么显示状态" —— 四个状态
     各自长什么样是卡片自己的事, 什么时候切换是共享模块的事。 */
  const speaker = createSpeaker({ onState: setSpeakState, rate: 0.95 });

  function setSpeakState(state) {
    speakButton.dataset.state = state;
    const label = SPEAK_LABEL[state] || SPEAK_LABEL.idle;
    speakButton.setAttribute('aria-label', label);
    speakButton.title = label;
    /* state === 'playing' 复用喇叭图形, 靠 CSS 的脉冲动画区分 —— 换一个
       "正在响"的图形反而要用户重新认一遍按钮在哪。 */
    mount(speakButton, state === 'loading'
      ? icon('spinner', { size: 20, class: 'word-card__spin' })
      : state === 'retry'
        ? icon('retry', { size: 20 })
        : icon('speaker', { size: 20 }));
  }

  function speak() {
    const value = token?.text;
    if (!value) return;
    speaker.speak(value, { owner: 'word-card' });
  }

  return {
    root,
    show,
    hide,
    get visible() { return !root.hidden; },
    get token() { return token; },
    /** 卡片被换掉之前必须停掉朗读, 否则声音会比界面多活好几秒。 */
    dispose() { speaker.dispose(); },
  };
}

// -------------------------------------------------------------------- 工具

function action(glyph, label, onClick, { primary = false } = {}) {
  return el('button', {
    class: `word-card__action${primary ? ' word-card__action--primary' : ''}`,
    type: 'button',
    on: { click: onClick },
  }, icon(glyph, { size: 18 }), el('span', null, label));
}

function tagNameOf(token) {
  const raw = token?.tag || token?.pos || token?.kind || '';
  if (!raw) return '';
  const key = String(raw).trim().toLowerCase();
  return TAG_NAMES[key] || String(raw);
}

/* 把例句里的目标词裹进 <mark>。用 indexOf 而不是正则: token.text 是接口
   来的字符串, 里面可能有 `.` `(` `*` 这类正则元字符, 拼进 RegExp 要么报错
   要么变成通配, 把不该高亮的地方也标上。 */
function highlight(text, needle) {
  const fragment = document.createDocumentFragment();
  const source = String(text ?? '');
  const target = String(needle ?? '');
  if (!target) { fragment.appendChild(document.createTextNode(source)); return fragment; }

  const lower = source.toLowerCase();
  const lowerTarget = target.toLowerCase();
  let cursor = 0;
  let hit = lower.indexOf(lowerTarget);

  if (hit === -1) { fragment.appendChild(document.createTextNode(source)); return fragment; }

  while (hit !== -1) {
    if (hit > cursor) fragment.appendChild(document.createTextNode(source.slice(cursor, hit)));
    fragment.appendChild(el('mark', { class: 'word-card__hit' }, source.slice(hit, hit + target.length)));
    cursor = hit + target.length;
    hit = lower.indexOf(lowerTarget, cursor);
  }
  if (cursor < source.length) fragment.appendChild(document.createTextNode(source.slice(cursor)));
  return fragment;
}

/* 剪贴板: `navigator.clipboard` 只在安全上下文(https / localhost)里存在。
   内网 http:// 打开时它是 undefined, 所以留一条 execCommand 的老路 ——
   不能因为部署在 IP 上就让"复制"这个按钮点了没反应。 */
async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch { /* 权限被拒或非安全上下文, 落到下面那条路 */ }
  }

  const area = el('textarea', { class: 'visually-hidden', readonly: true, tabindex: '-1' });
  area.value = value;
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
