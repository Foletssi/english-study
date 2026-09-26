/* Eastudy V3 — video learning classroom.

   The heart of the student experience, and the surface the legacy got most
   wrong in the rebuild (it became a card grid with a bare <video>).

   ---------------------------------------------------------------------------
   版面: 为什么所有东西都是 .player 的直接子节点

   手机端参考稿的纵向顺序是

       顶栏 / 画面 / 模式行 / 字幕 / 进度 / 控制行 / 底栏

   而宽屏端是"画面在左、字幕在右", 进度和控制行压在画面下面。两种排法差得
   很远, 但**不是两套 DOM** —— 只是同一批节点放的位置不同。

   做法是把它们全部平铺成 .player 的直接子节点, 由 CSS Grid 用
   grid-template-areas 摆位(见 app.css 的 1080px 断点)。这样切换断点时没有
   任何节点被搬来搬去: 搬迁会丢掉播放状态、会打断正在跑的 CSS 过渡、还要在
   JS 里判断屏幕宽度 —— 而屏幕宽度是 CSS 最擅长的事, 不该抄进 JS。

   唯一的例外是词卡: 宽屏它是右栏里的一张卡, 手机上它是从底部升起的浮层。
   这个差异靠 CSS 就行(position: fixed + 高度), DOM 里它始终在同一处。

   ---------------------------------------------------------------------------
   旧实现被删掉的两颗胶囊: 跟读 / 挖空

   它们不是参考稿上的东西, 是上一轮我自己加的。"跟读"和"单句循环"在功能上
   本来就是同一件事(反复听一句) —— 并排放着, 用户得先做一次没有意义的区分
   才能点对。参考稿的模式行是四个互斥的模式(连续 / 逐句 / 单句循环 / 听写
   填空), 现在按这个来。

   播放器自带的功能一个没少: 倍速、盲听、上下句、更多。它们被挪到了参考稿
   指定的位置 —— 倍速和盲听在底部控制行, 不在上面那排模式里。 */

import { el, mount, setText } from '../core/dom.js';
import { emit } from '../core/bus.js';
import { duration as formatDuration } from '../core/format.js';
import { icon } from './icons.js';
import { createWordCard } from './word-card.js';
import { createSpeaker, SPEAK_LABEL } from './speech.js';

const SEEK_DRAG_THRESHOLD_PX = 12;

/** 四个互斥的听课模式 —— 参考稿模式行上的四个, 顺序一致。
 *  互斥是刻意的: "逐句暂停"和"单句循环"同时开着的语义没人说得清, 与其定义
 *  清楚不如不让它发生。 */
const MODES = Object.freeze([
  { id: 'continuous', glyph: 'play', label: '连续播放', hint: '一直播下去, 字幕跟着走' },
  { id: 'sentence', glyph: 'pause', label: '逐句暂停', hint: '每句读完自动停下' },
  { id: 'loop', glyph: 'repeat', label: '单句循环', hint: '当前这句反复读' },
  { id: 'cloze', glyph: 'subtitle', label: '听写填空', hint: '重点词挖空, 边听边填' },
]);

const RATE_LADDER = Object.freeze([0.75, 1, 1.25, 1.5, 2]);

/** 逐句暂停的"读完"判定留一点余量: 句子的 end 常常压在下一个字的第一帧上,
 *  严格 >= end 会把它吃掉半个词。 */
const SENTENCE_END_EPSILON = 0.12;

const SPEAK_RATE_STORAGE_KEY = 'eastudy.v3.player.rate';
const FONT_STEP_STORAGE_KEY = 'eastudy.v3.player.fontStep';
const FONT_STEPS = Object.freeze([0, 1, 2]);   // 字幕字号档位, 0 是默认

export function createPlayer({ container, onProgress, onSentenceChange, onWordClick, onComplete, onNotify, onBack, onLearned } = {}) {
  let hls = null;
  let sessionEpoch = 0;
  let currentVideo = null;
  let sentences = [];
  let activeSentence = -1;
  let activeWord = null;
  let playbackRate = 1;
  let mode = 'continuous';
  let blind = false;
  let fontStep = readNumber(FONT_STEP_STORAGE_KEY, 0, FONT_STEPS);
  const starred = new Set();
  let disposers = [];

  const video = el('video', {
    class: 'player__video',
    playsinline: true,
    preload: 'metadata',
    controls: false,
    crossorigin: 'anonymous',
  });

  /* 朗读器是全页共用的: 单句的喇叭和词卡的喇叭都走它, 因此"谁在响"只有一处
     记账。当前占用者用句子下标表示 —— 换句时上一句的按钮会自动退回 idle。 */
  const speaker = createSpeaker({
    rate: 0.95,
    onState: (state) => {
      for (const [index, button] of speakButtons.entries()) {
        if (index !== activeSpeakIndex) continue;
        applySpeakState(button, state);
      }
    },
  });
  let activeSpeakIndex = -1;
  const speakButtons = new Map();
  const starButtons = new Map();

  // ------------------------------------------------------------------ 顶栏

  const backButton = el('button', {
    class: 'player__top-btn', type: 'button', 'aria-label': '返回视频库',
    on: { click: () => emitBack() },
  }, icon('arrowLeft', { size: 20 }));

  const topTitle = el('h1', { class: 'player__top-title' });

  /* 顶栏的主题按钮。它只翻浅深 —— 换色系在主题面板里做。按钮上的图形跟的是
     **屏幕上实际显示的模式**, 而不是偏好: 偏好在 'system' 时不等于任何一边,
     拿它去画图标会出现"图标是太阳、屏幕是深色"。 */
  const themeButton = el('button', {
    class: 'player__top-btn', type: 'button',
    on: { click: () => toggleTheme() },
  }, icon('sun', { size: 20 }));

  const topBar = el('header', { class: 'player__topbar' },
    backButton,
    el('div', { class: 'player__top-title-wrap' }, topTitle),
    themeButton,
  );

  // ------------------------------------------------------------------ 画面

  const videoNow = el('span', { class: 'player__stage-time' }, '0:00');
  const videoTotal = el('span', { class: 'player__stage-total' }, '0:00');

  const fullscreenButton = el('button', {
    class: 'player__stage-btn', type: 'button', 'aria-label': '全屏',
    on: { click: () => toggleFullscreen() },
  }, icon('expand', { size: 18 }));

  /* 画面里的时间与全屏按钮。压在画面上而不是放在下面的进度行里 —— 参考稿
     就是这样, 而且这也是播放器的通行做法: 眼睛在画面上的时候, 时间应该在
     同一个视野里。 */
  const stage = el('div', { class: 'player__stage player-surface' },
    video,
    el('div', { class: 'player__stage-overlay' },
      el('div', { class: 'player__stage-times' }, videoNow, el('span', { class: 'player__stage-slash' }, '/'), videoTotal),
      el('div', { class: 'player__spacer' }),
      fullscreenButton,
    ),
    el('div', { class: 'player__stage-empty' }, '该视频还没有字幕。'),
  );

  // ------------------------------------------------------------------ 模式

  const modeButtons = new Map();
  const modeRow = el('div', { class: 'player__modes', role: 'group', 'aria-label': '听课模式' },
    ...MODES.map((entry) => {
      const button = el('button', {
        class: 'player__mode', type: 'button',
        'aria-pressed': 'false',
        title: entry.hint,
        on: { click: () => setMode(entry.id) },
      }, icon(entry.glyph, { size: 18 }), el('span', null, entry.label));
      modeButtons.set(entry.id, button);
      return button;
    }),
  );

  // ------------------------------------------------------------------ 字幕

  const subtitleList = el('ol', { class: 'player__subtitles' });

  /* 盲听态的替身。参考稿把句子换成了灰条 —— 但**时间戳和两个按钮还在**,
     这一点很重要: 盲听是"不看字", 不是"这页废了", 学员仍然要能跳到某一句、
     仍然要能重听、仍然要能收藏。所以灰条是句子正文的骨架, 不是整行的替身。 */
  const blindNotice = el('div', { class: 'player__blind' },
    el('p', { class: 'player__blind-text' }, '正在盲听'),
    el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      on: { click: () => setBlind(false) },
    }, '显示字幕'),
  );

  // ------------------------------------------------------------------ 进度

  const barFill = el('div', { class: 'player__bar-fill' });
  const barBuffer = el('div', { class: 'player__bar-buffer' });
  const barHandle = el('div', { class: 'player__bar-handle' });
  const bar = el('div', {
    class: 'player__bar',
    role: 'slider',
    tabindex: '0',
    'aria-label': '播放进度',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
  }, barBuffer, barFill, barHandle);

  const timeNow = el('span', { class: 'player__time' }, '0:00');
  const timeTotal = el('span', { class: 'player__time' }, '0:00');

  /* 进度行两端各一个时间 —— 参考稿是 01:35 ━●━ 10:43 这样一排, 而不是把时间
     塞进控制行。左边是"到哪了", 右边是"总共多长", 分开放在它们各自描述的那
     一端, 扫一眼就知道还剩多少。 */
  const progressRow = el('div', { class: 'player__progress' }, timeNow, bar, timeTotal);

  // ---------------------------------------------------------------- 控制行

  /* 控件用内联 SVG 而不是字符字形。字符的问题不是难看, 是**对齐**: ▶ 在
     大多数字体里偏右、❚❚ 偏窄, 几个按钮并排时视觉重心各不相同, 换一个字体
     整套就歪。图形由 viewBox 决定, 与字体无关。 */
  const rateButton = controlButton('倍速', 'sliders', () => cycleRate(), { text: '1x' });
  const blindButton = controlButton('盲听', 'ear', () => setBlind(!blind), { pressed: false });
  const prevButton = controlButton('上一句', 'skipBack', () => gotoSentence(activeSentence - 1));
  const playButton = el('button', {
    class: 'player__play', type: 'button', 'aria-label': '播放',
    on: { click: () => togglePlay() },
  }, icon('play', { size: 28 }));
  const nextButton = controlButton('下一句', 'skipForward', () => gotoSentence(activeSentence + 1));
  const moreButton = controlButton('更多', 'more', (event) => toggleMore(event));

  const controls = el('div', { class: 'player__controls' },
    rateButton, blindButton, prevButton, playButton, nextButton, moreButton,
  );

  /* 更多菜单。参考稿这里是底部动作面板; web 上没有原生那一层, 所以做成一
     个弹出菜单, 而且**只放真实存在的动作** —— 下载、分享、举报那一套里,
     举报我们没有这个流程, 分享只有复制链接一种。宁可菜单短一点。 */
  const moreMenu = el('div', { class: 'player__more', hidden: true, role: 'menu' },
    menuItem('复制链接', 'copy', () => copyLink()),
    menuItem('下载字幕', 'listPlay', () => downloadSubtitles()),
    menuItem('字幕调大', 'textAa', () => stepFont(1), { id: 'font-up' }),
  );

  // ------------------------------------------------------------------ 底栏

  /* 底栏四个入口。数字不是装饰 —— 它们是这一课真实的可操作项数量, 没有数据
     的时候整个角标消失, 而不是显示 0 (显示 0 会让人以为功能坏了)。 */
  const keyCount = el('span', { class: 'player__stat-badge', hidden: true }, '0');
  const newCount = el('span', { class: 'player__stat-badge', hidden: true }, '0');

  const keyStat = statButton('textAa', '重点词', keyCount, () => toggleCloze());
  const vocabStat = statButton('bookmark', '生词本', newCount, () => toggleStarredOnly());
  const learnedStat = statButton('check', '标记已学', null, () => markLearned());
  const tocStat = statButton('listPlay', '视频目录', null, () => onNotify?.('目录功能等待接入视频章节数据', 'info'));

  const footer = el('nav', { class: 'player__footer', 'aria-label': '学习工具' },
    keyStat, vocabStat, learnedStat, tocStat,
  );

  /* 词卡单独成组件(ui/word-card.js): 它有四个发音状态、复制、关注、例句
     高亮, 塞在播放器里会让这个文件同时管播放和词汇两件事。播放器只负责把
     "点了哪个词"和"这个词在哪句里"递过去。 */
  const wordCard = createWordCard({
    onPlaySentence: (sentence) => {
      if (!sentence) return;
      video.currentTime = sentence.start;
      video.play().catch(() => {});
    },
    onAdd: (payload) => emit('vocabulary:add', payload),
    onFollow: (payload) => emit('vocabulary:follow', payload),
    onNotify: onNotify,
  });

  /* 词卡、盲听提示、字幕三者是同一栏的东西, 所以包一层。
     不这么做的话它们会各自是 .player 的网格项, 宽屏时就会散到不同行里 ——
     而参考稿要求它们竖着摞在同一列(词卡在最上, 因为它是刚点出来的;
     盲听提示紧贴字幕, 因为它解释的正是字幕为什么是灰的)。
     手机端词卡是 position: fixed 的浮层, 已经脱离文档流, 这一层就只剩
     盲听提示 + 字幕, 正好对上参考稿的顺序。 */
  const sideStack = el('div', { class: 'player__side' },
    wordCard.root,
    blindNotice,
    subtitleList,
  );

  const root = el('div', { class: 'player' },
    topBar,
    stage,
    modeRow,
    progressRow,
    controls,
    footer,
    moreMenu,
    sideStack,
  );

  // -------------------------------------------------------------- 播放控制

  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function seekBy(delta) {
    if (!Number.isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta));
  }

  function cycleRate() {
    const next = RATE_LADDER[(RATE_LADDER.indexOf(playbackRate) + 1) % RATE_LADDER.length];
    setRate(next);
    onNotify?.(`${next}x 播放`, 'info');
  }

  function setRate(rate) {
    playbackRate = rate;
    video.playbackRate = rate;
    const label = rateButton.querySelector('.player__control-text');
    if (label) setText(label, `${rate}x`);
  }

  function setMode(next) {
    if (!MODES.some((entry) => entry.id === next)) return;
    mode = next;
    for (const [id, button] of modeButtons) {
      const on = id === next;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    /* 逐句暂停第一次打开时立刻暂停 —— 否则要等这一句读完才生效, 而用户点它
       的意图通常是"就停在这儿"。 */
    if (next === 'sentence' && !video.paused) video.pause();
    root.dataset.mode = mode;
    root.classList.toggle('is-cloze', mode === 'cloze');
  }

  function setBlind(next) {
    blind = Boolean(next);
    blindButton.classList.toggle('is-on', blind);
    blindButton.setAttribute('aria-pressed', String(blind));
    root.classList.toggle('is-blind', blind);
    blindNotice.hidden = !blind || !sentences.length;
    /* 盲听时不念 —— 盲听练的就是"只听声音、不看字", 这时候把字幕念出来等于
       把训练目标拆掉。 */
    if (blind) stopSpeaking();
  }

  function toggleStarredOnly() {
    root.classList.toggle('is-starred-only');
    const on = root.classList.contains('is-starred-only');
    onNotify?.(on ? '只看收藏的句子' : '显示全部句子', 'info');
  }

  async function toggleFullscreen() {
    const target = stage;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await target.requestFullscreen?.();
    } catch {
      onNotify?.('这个浏览器不允许全屏', 'error');
    }
  }

  /* 上一句 / 下一句。跳完要播 —— 只是把游标挪过去的话, 用户还要再点一次
     播放, 而"听下一句"这个动作本身就把播放意愿说清楚了。 */
  function gotoSentence(index) {
    if (!sentences.length) return;
    const clamped = Math.max(0, Math.min(sentences.length - 1, index));
    video.currentTime = sentences[clamped].start;
    video.play().catch(() => {});
  }

  function nearestSentence(time) {
    for (let i = 0; i < sentences.length; i++) {
      if (time >= sentences[i].start && time < sentences[i].end) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ 更多

  function toggleMore(event) {
    event?.stopPropagation?.();
    moreMenu.hidden = !moreMenu.hidden;
    moreButton.setAttribute('aria-expanded', String(!moreMenu.hidden));
  }

  function closeMore() {
    if (moreMenu.hidden) return;
    moreMenu.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
  }

  /* 点别处、按 Esc 都要收起菜单 —— 菜单没收起就去点播放键是很常见的下一步,
     挡在那里会让人以为按钮坏了。 */
  function onDocumentClick(event) {
    if (!moreMenu.hidden && !moreMenu.contains(event.target) && !moreButton.contains(event.target)) closeMore();
  }
  function onKeydown(event) {
    if (event.key === 'Escape') { closeMore(); return; }
    /* 空格是播放/暂停的通行快捷键, 但光标在输入框里时它得能打空格。 */
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    if (event.key === ' ') { togglePlay(); event.preventDefault(); }
    if (event.key === 'ArrowRight') { seekBy(5); event.preventDefault(); }
    if (event.key === 'ArrowLeft') { seekBy(-5); event.preventDefault(); }
  }
  document.addEventListener('click', onDocumentClick);
  root.addEventListener('keydown', onKeydown);
  disposers.push(() => document.removeEventListener('click', onDocumentClick));

  async function copyLink() {
    closeMore();
    const url = `${location.origin}${location.pathname}#/watch/${encodeURIComponent(currentVideo?.id ?? '')}`;
    const ok = await writeClipboard(url);
    onNotify?.(ok ? '链接已复制' : '复制失败, 请手动复制地址栏', ok ? 'success' : 'error');
  }

  function downloadSubtitles() {
    closeMore();
    if (!sentences.length) { onNotify?.('这个视频没有字幕文件', 'error'); return; }
    const lines = [];
    sentences.forEach((sentence, index) => {
      lines.push(String(index + 1));
      lines.push(`${stamp(sentence.start)} --> ${stamp(sentence.end)}`);
      lines.push(sentence.text);
      if (sentence.translation) lines.push(sentence.translation);
      lines.push('');
    });
    const name = `${currentVideo?.title || 'subtitles'}.srt`.replace(/[\\/:*?"<>|]/g, '_');
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
    const link = el('a', { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    /* 立刻 revoke 会让部分浏览器拿到空文件; 让出这一轮事件循环再回收。 */
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onNotify?.('字幕已下载', 'success');
  }

  function stepFont(delta) {
    closeMore();
    const at = FONT_STEPS.indexOf(fontStep);
    const next = FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, at + delta))];
    fontStep = next;
    writeNumber(FONT_STEP_STORAGE_KEY, next);
    root.dataset.fontStep = String(next);
    onNotify?.(next === FONT_STEPS[FONT_STEPS.length - 1] ? '字幕已是最大' : '字幕已调大', 'info');
  }

  // ------------------------------------------------------------------ 标记

  /* 「标记已学」是**用户主动的声明**, 不是"看完了" —— 完成与否由服务端从
     观看覆盖率算(functions/api/progress.js), 两者是不同的东西, 所以这一键
     走的是 `learned_at` 这一列, 不碰 `completed`。

     界面上先亮灯再发请求: 按钮按下到网络回包之间有一段空档, 等回包再亮
     等于让用户怀疑自己没点到。失败了由调用方把灯收回去 —— 乐观更新可以,
     乐观更新完不负责回滚不行。 */
  function markLearned() {
    if (!currentVideo?.id) return;
    const videoId = currentVideo.id;
    const on = learnedStat.getAttribute('aria-pressed') !== 'true';
    paintLearned(on);
    onLearned?.({ videoId, learned: on });
  }

  /* 亮灯的唯一入口。两个地方要用: 点击时乐观点亮, 失败时收回。
     标签一起改 —— 灯亮着但还写着「标记已学」是自相矛盾的。 */
  function paintLearned(on) {
    learnedStat.classList.toggle('is-on', Boolean(on));
    learnedStat.setAttribute('aria-pressed', on ? 'true' : 'false');
    setText(
      learnedStat.querySelector('.player__stat-label'),
      on ? '已学完' : '标记已学',
    );
  }

  // ------------------------------------------------------------------ 字幕

  function renderSentences() {
    subtitleList.hidden = !sentences.length;
    modeRow.hidden = !sentences.length;
    blindNotice.hidden = !blind || !sentences.length;
    speakButtons.clear();
    starButtons.clear();
    activeSpeakIndex = -1;

    mount(subtitleList, ...sentences.map((sentence, index) => {
      const body = el('p', { class: 'player__sentence-text' });
      for (const token of sentence.tokens || [{ text: sentence.text }]) {
        const isKey = Boolean(token.key);
        body.appendChild(el('span', {
          class: ['word-token', token.key ? 'is-key' : null, token.level ? `level-${token.level}` : null].filter(Boolean).join(' '),
          dataset: { word: token.text, tokenId: token.id ?? '' },
          title: token.gloss || null,
          on: token.id ? { click: (event) => { event.stopPropagation(); selectWord(token, sentence); } } : undefined,
        }, token.text));
      }

      const translation = sentence.translation
        ? el('p', { class: 'player__sentence-translation' }, sentence.translation)
        : null;

      /* 每句两个动作: 重听这一句、收藏这一句。参考稿每行右侧都有这两个。
         它们不是"次要功能" —— 精听时用得最多的就是反复听同一句。 */
      const speakButton = el('button', {
        class: 'player__sentence-btn player__sentence-speak', type: 'button',
        'data-state': 'idle',
        on: { click: (event) => { event.stopPropagation(); speakSentence(index); } },
      });
      applySpeakState(speakButton, 'idle');
      speakButtons.set(index, speakButton);

      const starButton = el('button', {
        class: 'player__sentence-btn player__sentence-star', type: 'button',
        on: { click: (event) => { event.stopPropagation(); toggleStar(index); } },
      });
      applyStarState(starButton, index);
      starButtons.set(index, starButton);

      return el('li', {
        class: 'player__sentence',
        dataset: { index: String(index) },
        on: { click: () => { video.currentTime = sentence.start; video.play().catch(() => {}); } },
      },
        el('div', { class: 'player__sentence-main' }, body, translation),
        el('div', { class: 'player__sentence-foot' },
          el('span', { class: 'player__sentence-time' }, formatDuration(sentence.start)),
          el('div', { class: 'player__spacer' }),
          speakButton,
          starButton,
        ),
      );
    }));

    updateFooterCounts();
  }

  function selectWord(token, sentence) {
    activeWord = token;
    wordCard.show({ token, sentence, video: currentVideo });
    /* 重点词的高亮由 CSS 从 .is-key 给出; 被选中的那颗额外挂一个类, 好让教学
       配色由 token 文件决定, 而不是一条内联样式 —— 内联样式在切换主题时会
       被漏掉, 老版本就是因此把高亮刷成了普通黑色。

       选择器用 dataset 而不是拼字符串: `token.id` 是接口数据, 理论上可能含
       引号, 直接拼进选择器会抛 SyntaxError 把整段高亮逻辑带走。 */
    for (const node of subtitleList.querySelectorAll('.word-token.is-active')) node.classList.remove('is-active');
    if (token.id) {
      for (const node of subtitleList.querySelectorAll('.word-token')) {
        if (node.dataset.tokenId === String(token.id)) node.classList.add('is-active');
      }
    }
    onWordClick?.(token, sentence);
  }

  function speakSentence(index) {
    if (blind) return;
    const sentence = sentences[index];
    if (!sentence) return;
    activeSpeakIndex = index;
    speaker.speak(sentence.text, { owner: index });
  }

  function stopSpeaking() {
    activeSpeakIndex = -1;
    speaker.stop();
  }

  function applySpeakState(button, state) {
    button.dataset.state = state;
    const label = SPEAK_LABEL[state] || SPEAK_LABEL.idle;
    button.setAttribute('aria-label', label);
    button.title = label;
    /* state === 'playing' 复用喇叭图形, 靠 CSS 的脉冲动画区分 —— 换一个"正在
       响"的图形反而要用户重新认一遍按钮在哪。 */
    mount(button, state === 'loading'
      ? icon('spinner', { size: 18, class: 'player__spin' })
      : state === 'retry'
        ? icon('retry', { size: 18 })
        : icon('speaker', { size: 18 }));
  }

  function toggleStar(index) {
    if (starred.has(index)) starred.delete(index); else starred.add(index);
    const button = starButtons.get(index);
    if (button) applyStarState(button, index);
    updateFooterCounts();
  }

  function applyStarState(button, index) {
    const on = starred.has(index);
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-label', on ? '取消收藏这一句' : '收藏这一句');
    mount(button, icon(on ? 'starFilled' : 'star', { size: 18 }));
  }

  function updateFooterCounts() {
    const keys = sentences.reduce((sum, sentence) => (
      sum + (sentence.tokens || []).filter((token) => token.key).length
    ), 0);
    keyCount.hidden = !keys;
    setText(keyCount, String(keys));
    newCount.hidden = !starred.size;
    setText(newCount, String(starred.size));
  }

  // --------------------------------------------------------------- 事件

  function onTimeUpdate() {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    if (!dragging) paintBar(video.currentTime / video.duration, false);
    setText(timeNow, formatDuration(video.currentTime));
    setText(videoNow, formatDuration(video.currentTime));

    const index = nearestSentence(video.currentTime);
    if (index === activeSentence) return;

    activeSentence = index;
    Array.from(subtitleList.children).forEach((node, i) => {
      node.classList.toggle('is-active', i === index);
    });
    const node = subtitleList.children[index];
    if (node && !dragging) {
      // Only scroll when the active row would leave the viewport: constant
      // recentering fights the learner who is reading ahead.
      const box = subtitleList.getBoundingClientRect();
      const row = node.getBoundingClientRect();
      if (row.top < box.top + 8 || row.bottom > box.bottom - 8) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    onSentenceChange?.(index >= 0 ? sentences[index] : null, index);

    if (index < 0) return;

    /* 模式到这一句该做的事。三个模式里只有两个会在这里动手 —— 连续播放
       什么都不做, 这正是它和"逐句暂停"的区别。 */
    const sentence = sentences[index];
    if (mode === 'loop' && video.currentTime >= sentence.end - 0.05) {
      video.currentTime = sentence.start;
      return;
    }
    if (mode === 'sentence' && !video.paused && video.currentTime >= sentence.end - SENTENCE_END_EPSILON) {
      video.pause();
    }
  }

  function onEnded() {
    onComplete?.({ videoId: currentVideo?.id });
  }

  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('ended', onEnded);
  /* 播放/暂停换的是整个 SVG 节点, 所以要 `mount` 而不是改 textContent ——
     图形不是文案, 写 textContent 只会得到一串 "[object DocumentFragment]"。 */
  video.addEventListener('play', () => {
    mount(playButton, icon('pause', { size: 28 }));
    playButton.setAttribute('aria-label', '暂停');
  });
  video.addEventListener('pause', () => {
    mount(playButton, icon('play', { size: 28 }));
    playButton.setAttribute('aria-label', '播放');
  });
  video.addEventListener('loadedmetadata', () => {
    setText(timeTotal, formatDuration(video.duration));
    setText(videoTotal, formatDuration(video.duration));
    paintBar(0, false);
  });

  function paintBar(ratio, preview) {
    const pct = `${(ratio * 100).toFixed(2)}%`;
    barFill.style.width = pct;
    barHandle.style.left = pct;
    bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    if (preview && Number.isFinite(video.duration)) {
      setText(timeNow, formatDuration(ratio * video.duration));
    }
  }

  // ------------------------------------------------------------------ 拖拽

  let dragging = false;
  let dragStartX = 0;
  let dragMoved = false;

  function ratioFromEvent(event) {
    const rect = bar.getBoundingClientRect();
    const x = (event.touches?.[0]?.clientX ?? event.clientX) - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }

  function onPointerDown(event) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    dragging = true;
    dragMoved = false;
    dragStartX = event.touches?.[0]?.clientX ?? event.clientX;
    bar.setPointerCapture?.(event.pointerId ?? 0);
    paintBar(ratioFromEvent(event), true);
  }

  function onPointerMove(event) {
    if (!dragging) return;
    const x = event.touches?.[0]?.clientX ?? event.clientX;
    if (Math.abs(x - dragStartX) > SEEK_DRAG_THRESHOLD_PX) dragMoved = true;
    paintBar(ratioFromEvent(event), true);
  }

  function onPointerUp(event) {
    if (!dragging) return;
    dragging = false;
    const ratio = ratioFromEvent(event);
    // A short tap jumps; a deliberate horizontal drag scrubs. Both commit, but
    // only a drag suppresses the click handler that follows on touch devices.
    video.currentTime = ratio * video.duration;
    paintBar(ratio, false);
    if (dragMoved) event.preventDefault?.();
  }

  bar.addEventListener('pointerdown', onPointerDown);
  bar.addEventListener('pointermove', onPointerMove);
  bar.addEventListener('pointerup', onPointerUp);
  bar.addEventListener('pointercancel', () => { dragging = false; });
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') { seekBy(5); event.preventDefault(); }
    if (event.key === 'ArrowLeft') { seekBy(-5); event.preventDefault(); }
    if (event.key === ' ') { togglePlay(); event.preventDefault(); }
  });

  // ------------------------------------------------------------------ 主题

  /* 播放页自带的主题按钮。它**不改主题控制器** —— 播放器拿不到那个实例, 也
     不该拿。它只翻 documentElement 上的 data-mode 并换自己的图标: 色系的
     大部分规则都挂在 `[data-mode]` 上, 所以翻这一个属性, 页面上所有 CSS 变量
     就跟着换了。 */
  function toggleTheme() {
    const root_ = document.documentElement;
    const next = root_.dataset.mode === 'dark' ? 'light' : 'dark';
    root_.dataset.mode = next;
    root_.style.colorScheme = next;
    mount(themeButton, icon(next === 'dark' ? 'moon' : 'sun', { size: 20 }));
    themeButton.setAttribute('aria-label', next === 'dark' ? '切换到浅色' : '切换到深色');
  }

  /* 返回键。用回调, 不用总线。

     这条链路上只有一个消费者(学习页), 而为一次导航引一个全局事件, 代价是
     "谁在听"从代码上看不出来 —— 上一版就是这样: 广播发了, 没有任何订阅者,
     按钮点了没反应, 而代码不会报错。回调把这条边写在了明面上, 少一个订阅者
     就少一次导航, 一眼能看出来。 */
  function emitBack() {
    onBack?.({ videoId: currentVideo?.id });
  }

  // ---------------------------------------------------------------- 初始态

  setMode('continuous');
  setRate(1);
  root.dataset.fontStep = String(fontStep);
  subtitleList.hidden = true;
  modeRow.hidden = true;
  blindNotice.hidden = true;
  themeButton.setAttribute('aria-label', '切换深浅色');

  // ------------------------------------------------------------------ API

  return {
    root,

    /**
     * Load a video. Bumping the epoch invalidates any in-flight work from the
     * previous video, which is the fix for the legacy's cross-video bleed.
     */
    async load({ video: meta, playlistUrl, subtitles = [], resumeAt = 0 }) {
      const epoch = ++sessionEpoch;
      currentVideo = meta;
      sentences = subtitles;
      activeSentence = -1;
      activeWord = null;
      starred.clear();
      /* 换视频要把词卡收掉, 还要把朗读掐掉。留着上一课的词卡是最容易被忽略的
         跨课泄漏 —— 界面换成了新视频, 右边却还写着上一个词; 朗读更糟, 它比
         界面多活好几秒, 新视频还没开始就有人在念上一课的句子。 */
      stopSpeaking();
      wordCard.hide();

      setText(topTitle, meta?.title || '');
      renderSentences();

      if (hls) { hls.destroy(); hls = null; }
      video.pause();
      video.removeAttribute('src');

      if (window.Hls?.isSupported()) {
        hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
        hls.loadSource(playlistUrl);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (epoch !== sessionEpoch) return;   // stale error from the old video
          if (data.fatal) {
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          }
        });
      } else {
        video.src = playlistUrl;
      }

      if (resumeAt > 0) {
        const once = () => {
          if (epoch !== sessionEpoch) return;
          video.currentTime = resumeAt;
          video.removeEventListener('loadedmetadata', once);
        };
        video.addEventListener('loadedmetadata', once);
      }
      return epoch;
    },

    setSubtitles(next) {
      sentences = next;
      activeSentence = -1;
      starred.clear();
      stopSpeaking();
      renderSentences();
    },

    play() { return video.play().catch(() => {}); },
    pause() { video.pause(); },
    get element() { return video; },
    get currentTime() { return video.currentTime; },
    get mode() { return mode; },

    /** 供页面调用: 按服务端的 `learned_at` 把底栏那一键的灯摆正。
     *  两个时机要用 —— 进页时读回已有标记, 以及写入失败时把乐观的灯收回。 */
    setLearned(on) { paintLearned(on); },

    /** 供页面调用: 当前视频是否已标记。用于判断乐观更新要不要回滚。 */
    get learned() { return learnedStat.getAttribute('aria-pressed') === 'true'; },

    /** Explicit transaction for switching videos mid-session. */
    async switchVideo(load) {
      const previous = sessionEpoch;
      const epoch = await this.load(await load());
      return { previous, epoch, stale: epoch === previous };
    },

    dispose() {
      sessionEpoch++;
      stopSpeaking();
      speaker.dispose();
      wordCard.dispose();
      video.pause();
      if (hls) { hls.destroy(); hls = null; }
      video.removeAttribute('src');
      video.load();
      for (const dispose of disposers) { try { dispose(); } catch {} }
      disposers = [];
      container = null;
    },
  };
}

// -------------------------------------------------------------------- 工具

function controlButton(label, glyph, onClick, { text = '', pressed = null } = {}) {
  const button = el('button', {
    class: 'player__control', type: 'button',
    'aria-label': label, title: label,
    on: { click: onClick },
  }, icon(glyph, { size: 22 }));
  if (text) button.appendChild(el('span', { class: 'player__control-text' }, text));
  else button.appendChild(el('span', { class: 'player__control-label' }, label));
  if (pressed !== null) button.setAttribute('aria-pressed', String(pressed));
  return button;
}

function statButton(glyph, label, badge, onClick) {
  return el('button', {
    class: 'player__stat', type: 'button',
    // 这排按钮是**开关**(重点词/生词本/已学完都是开或关), 不是一次性动作,
    // 所以报 aria-pressed —— 只靠一个高亮类名, 读屏用户听不出来它是选中态。
    'aria-pressed': 'false',
    on: { click: onClick },
  },
    el('span', { class: 'player__stat-icon' }, icon(glyph, { size: 20 }), badge),
    el('span', { class: 'player__stat-label' }, label),
  );
}

function menuItem(label, glyph, onClick, { id = '' } = {}) {
  return el('button', {
    class: 'player__more-item', type: 'button', role: 'menuitem',
    dataset: id ? { action: id } : undefined,
    on: { click: onClick },
  }, icon(glyph, { size: 18 }), el('span', null, label));
}

/** 秒 -> SRT 时间戳 00:01:35,000 */
function stamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(total % 60)).padStart(2, '0');
  const ms = String(Math.round((total % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${s},${ms}`;
}

/* 剪贴板: `navigator.clipboard` 只在安全上下文(https / localhost)里存在。
   内网 http:// 打开时它是 undefined, 所以留一条 execCommand 的老路。 */
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

function readNumber(key, fallback, allowed) {
  try {
    const raw = Number(localStorage.getItem(key));
    return allowed.includes(raw) ? raw : fallback;
  } catch { return fallback; }
}

function writeNumber(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* 无痕模式 */ }
}
