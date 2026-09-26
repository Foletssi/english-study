/* Eastudy V3 — 版面校验台的入口 (仅开发用, 不进 dist)。

   为什么要有这个文件: 真实的 app 在没有 Supabase 凭据时会在
   assertSafeEnvironment() 那一关抛错, 整个页面渲染成致命错误屏, 于是
   "手机端排版对不对"这个问题根本没法看。

   它加载的是**真实的 player.js / word-card.js / filter-bar.js**, 不是手抄
   的一份 class 名。抄一份的问题不是费事, 是它会骗人 —— 手抄的 DOM 和模块
   真正吐出来的那一刻就开始漂移, 而校验的意义恰恰在于"我看到的和用户看到
   的是同一个东西"。所以这里给的是假数据, 走的是真代码。

   用法: node tools/layout-harness.mjs  然后开 http://127.0.0.1:8795 */

import { createPlayer } from '../src/ui/player.js';
import { createFilterBar } from '../src/ui/filter-bar.js';
import { toast, attachToastBridge } from '../src/ui/toast.js';
import { mount } from '../src/core/dom.js';
import { EVENTS, emit } from '../src/core/bus.js';

const SENTENCES = [
  {
    start: 0, end: 4.2, text: 'I have a few things to do today.', translation: '今天有几件事要做。',
    tokens: [
      { text: 'I' }, { text: 'have' }, { text: 'a' }, { text: 'few', id: 'w1', key: true, level: 1, gloss: '几个; 少量的', phonetic: '/fjuː/', pos: 'adj.' },
      { text: 'things' }, { text: 'to' }, { text: 'do' }, { text: 'today.' },
    ],
  },
  {
    start: 4.2, end: 9.8, text: "I'm trying to make the most of my mornings.", translation: '我想充分利用早上的时间。',
    tokens: [
      { text: 'I’m' }, { text: 'trying' }, { text: 'to' },
      {
        text: 'make the most of', id: 'w2', key: true, level: 2,
        phonetic: '/meɪk ðə məʊst ɒv/', pos: '短语',
        gloss: '充分利用; 把…发挥到极致',
        context: '这里指把早上的时间用好, 而不是单纯地"度过"。',
        example: { en: "She made the most of her free afternoon.", zh: '她充分用好了自己空闲的下午。' },
      },
      { text: 'my' }, { text: 'mornings.' },
    ],
  },
  {
    start: 9.8, end: 15.1, text: 'First, I brew a proper cup of coffee.', translation: '首先，我冲一杯像样的咖啡。',
    tokens: [
      { text: 'First,' }, { text: 'I' },
      { text: 'brew', id: 'w3', key: true, level: 1, gloss: '冲泡(咖啡、茶)', phonetic: '/bruː/', pos: 'v.' },
      { text: 'a' }, { text: 'proper' }, { text: 'cup' }, { text: 'of' }, { text: 'coffee.' },
    ],
  },
  {
    start: 15.1, end: 21.4, text: 'Then I go through my inbox before the meetings start.', translation: '然后在会议开始前把邮件过一遍。',
    tokens: [
      { text: 'Then' }, { text: 'I' }, { text: 'go' }, { text: 'through' }, { text: 'my' },
      { text: 'inbox', id: 'w4', key: true, level: 2, gloss: '收件箱', phonetic: '/ˈɪnbɒks/', pos: 'n.' },
      { text: 'before' }, { text: 'the' }, { text: 'meetings' }, { text: 'start.' },
    ],
  },
  {
    start: 21.4, end: 27.0, text: 'The rest of the day pretty much runs itself.', translation: '接下来的一整天基本就顺下去了。',
    tokens: [
      { text: 'The' }, { text: 'rest' }, { text: 'of' }, { text: 'the' }, { text: 'day' },
      { text: 'pretty much', id: 'w5', key: true, level: 3, gloss: '基本上; 差不多', phonetic: '/ˈprɪti mʌtʃ/', pos: 'adv.' },
      { text: 'runs' }, { text: 'itself.' },
    ],
  },
  {
    start: 27.0, end: 33.5, text: 'I try not to check my phone until lunch.', translation: '我尽量在午饭前不看手机。',
    tokens: [{ text: 'I' }, { text: 'try' }, { text: 'not' }, { text: 'to' }, { text: 'check' }, { text: 'my' }, { text: 'phone' }, { text: 'until' }, { text: 'lunch.' }],
  },
  {
    start: 33.5, end: 39.0, text: 'That single rule changed my whole morning.', translation: '就这一条规则改变了我整个上午。',
    tokens: [{ text: 'That' }, { text: 'single' }, { text: 'rule' }, { text: 'changed' }, { text: 'my' }, { text: 'whole' }, { text: 'morning.' }],
  },
  {
    start: 39.0, end: 45.0, text: 'By noon I have already done the hard part.', translation: '到了中午，难的部分我已经做完了。',
    tokens: [{ text: 'By' }, { text: 'noon' }, { text: 'I' }, { text: 'have' }, { text: 'already' }, { text: 'done' }, { text: 'the' }, { text: 'hard' }, { text: 'part.' }],
  },
];

const VIDEO = { id: 'demo-1', title: 'A Day in My Life', subtitle: '日常生活 · B1 进阶' };

/* 1x1 的空白 wav —— 只是为了不让 <video> 因为没有源而在控制台刷错误, 不影响版面。 */
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

const app = document.getElementById('app');
attachToastBridge();

// --------------------------------------------------------------- 播放器

const playerSlot = document.createElement('div');
playerSlot.className = 'watch__slot';
app.appendChild(playerSlot);

const player = createPlayer({
  onNotify: (message, variant) => toast(message, { variant }),
});
mount(playerSlot, player.root);

// video 元素本身不给真源 —— 上传的是黑框, 版面才是要看的。
player.element.addEventListener('loadedmetadata', () => {}, { once: true });
Object.defineProperty(player.element, 'duration', { value: 645, configurable: true });
player.element.dispatchEvent(new Event('loadedmetadata'));

/* 包一层 async: esbuild 的 target 是 es2020, 模块顶层不允许 await。 */
const ready = player.load({ video: VIDEO, playlistUrl: SILENT, subtitles: SENTENCES, resumeAt: 0 });

// --------------------------------------------------------------- 筛选条

const filterSlot = document.createElement('div');
filterSlot.className = 'catalog__filters';
app.appendChild(filterSlot);

const filterBar = createFilterBar({
  value: { duration: '', level: '', updated: 'latest' },
  sort: 'recent',
  onChange: () => {},
  onSort: () => {},
});
mount(filterSlot, filterBar.root);

// ------------------------------------------- 校验台的开关 (不影响组件样式)

document.getElementById('btn-theme').addEventListener('click', () => {
  const current = Number(document.documentElement.dataset.theme.slice(-2));
  document.documentElement.dataset.theme = `theme-${String((current % 12) + 1).padStart(2, '0')}`;
  document.getElementById('theme-name').textContent = document.documentElement.dataset.theme;
});

document.getElementById('btn-mode').addEventListener('click', () => {
  document.documentElement.dataset.mode = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
});

/* 词卡: 直接点字幕里的词, 走的是 selectWord 那条真路 */
document.getElementById('btn-card').addEventListener('click', () => {
  const token = SENTENCES[1].tokens.find((t) => t.id === 'w2');
  player.root.querySelector(`.word-token[data-token-id="w2"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  void token;
});

document.getElementById('btn-sheet').addEventListener('click', () => {
  filterBar.root.querySelector('.filter-bar__toggle').click();
});

document.getElementById('btn-scroll').addEventListener('click', () => {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
});
