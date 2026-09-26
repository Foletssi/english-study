/* Eastudy V3 — 朗读 (SpeechSynthesis)。

   参考稿在**每一句字幕**右侧都放了一个喇叭, 词卡里也有一个。两处都是同一件
   事: 把一段英文念出来, 并且让按钮如实显示此刻的状态。所以这套状态机只有
   一份实现 —— 抄成两份的代价不是多写几十行, 而是两边会慢慢长得不一样:
   后加的那个通常只做"点一下、念一下", 把 retry 那一路丢掉。

   ---------------------------------------------------------------------------
   四个状态, 缺一不可

     idle      安静, 可以点
     loading   已经交给浏览器, 还没出声 —— 转圈
     playing   正在响 —— 喇叭带脉冲
     retry     没念成 —— 换重试图标, 让用户再点一次

   retry 是这套状态机里最容易被省掉、也最不能省掉的一个。浏览器合成本身会
   失败: 系统里没有英文语音包、音频输出被别的标签页占着、Chrome 在用户跟
   页面交互过之前拒绝朗读、静默模式下也常常不触发 onstart。这些都不是"加载
   中" —— 把它们一律显示成转圈, 按钮就会永远转下去, 用户以为页面坏了。

   ---------------------------------------------------------------------------
   为什么是工厂而不是单例

   一个页面上同时存在十几个喇叭(每句一个)。浏览器的 speechSynthesis 是全局
   单例, 同一时刻只能念一段, 所以"谁在响"必须只有一处记账, 否则点第二句时
   第一句的按钮会一直亮着。这个记账放在这里, 用 owner 表示当前占用者:

       点 A  ->  A 是 owner
       点 B  ->  先告诉 A "你不是 owner 了" (A 退回 idle), 再让 B 出声

   组件只需要在 speak 时把"我怎么显示状态"的回调传进来, 不需要自己管时序。 */

/* 浏览器合成的 onstart 偶尔不来。等过这个时间就认定失败, 而不是把按钮永远
   停在"加载中" —— 一个永远转圈的按钮比一个说"没成功"的按钮难懂得多。 */
const START_TIMEOUT_MS = 1500;

/* 走 en-US 而不是按单词猜英音/美音: 猜错了读出来是错的, 还不如统一。 */
const LANG = 'en-US';

export const SPEAK_LABEL = Object.freeze({
  idle: '朗读',
  loading: '正在准备发音',
  playing: '正在朗读, 再点一次重听',
  retry: '发音没有成功, 点击重试',
});

/** 浏览器有没有合成本事。没有的话 speak() 会直接给 retry, 而不是静默失败。 */
export function speechSupported() {
  return typeof window !== 'undefined'
    && typeof window.SpeechSynthesisUtterance === 'function'
    && Boolean(window.speechSynthesis);
}

/* 语音包列表在 Chrome 上第一次调用是空的, 要等 voiceschanged。这里不去监听
   那个事件: 拿不到就返回 null, 交给浏览器按 `lang` 自己挑, 挑出来的至少是
   英语; 为了一个"更好听的音色"把首屏绑在一个事件上不值得。 */
let cachedVoice = null;

function pickVoice(synth) {
  if (cachedVoice) return cachedVoice;
  const voices = synth.getVoices?.() ?? [];
  if (!voices.length) return null;
  cachedVoice = voices.find((v) => /^en[-_]GB/i.test(v.lang) && /female|Sonia|Libby|Serena|Kate/i.test(v.name))
    ?? voices.find((v) => /^en[-_]US/i.test(v.lang))
    ?? voices.find((v) => /^en/i.test(v.lang))
    ?? null;
  return cachedVoice;
}

/**
 * 造一个朗读器。
 *
 * @param {(state: 'idle'|'loading'|'playing'|'retry') => void} [onState]
 *        状态变化的回调。**只有占用者的回调会被调用** —— 已经退位的那个
 *        不会在别人念到一半时被通知, 因此不会互相把图标刷掉。
 * @param {number} [rate] 语速, 默认 0.95 (比原速略慢, 便于跟读)。
 */
export function createSpeaker({ onState, rate = 0.95 } = {}) {
  let owner = null;        // 当前占用者 (任意对象, 只用来做身份比较)
  let utterance = null;
  let timer = null;

  function report(state) {
    try { onState?.(state); } catch { /* 单个回调出错不该带走发音 */ }
  }

  function clearTimer() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  /* 退位。参数是不该再收到通知的那个占用者 —— 传了就只在该占用者仍然在
     位时执行, 避免把刚上位的新占用者顺手掐掉。 */
  function release(who) {
    if (who !== undefined && who !== owner) return;
    owner = null;
    utterance = null;
    clearTimer();
    try { window.speechSynthesis?.cancel(); } catch { /* 没实现就算了 */ }
  }

  /**
   * 念一段。会先掐掉上一段 —— 点第二句时第一句还在响的话, 用户听到的是
   * 两句话叠在一起。
   *
   * @param {string} text
   * @param {{ owner?: unknown, locale?: string }} [options]
   */
  function speak(text, { owner: nextOwner, locale = LANG } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return;

    release();                       // 谁在响都先停掉, 包括自己上一遍
    if (!speechSupported()) { report('retry'); return; }

    const synth = window.speechSynthesis;
    const next = new SpeechSynthesisUtterance(value);
    next.lang = locale;
    next.rate = rate;
    const voice = pickVoice(synth);
    if (voice) next.voice = voice;

    owner = nextOwner ?? next;
    utterance = next;
    report('loading');

    /* 这三个回调都要先确认自己还是当前那次 —— 用户可能在半秒内点了三句,
       onstart 是异步来的, 不确认的话第二句的 onstart 会把第三句的图标刷
       回 idle。 */
    next.onstart = () => {
      if (utterance !== next) return;
      clearTimer();
      report('playing');
    };
    next.onend = () => {
      if (utterance !== next) return;
      clearTimer();
      owner = null;
      utterance = null;
      report('idle');
    };
    next.onerror = () => {
      if (utterance !== next) return;
      clearTimer();
      owner = null;
      utterance = null;
      report('retry');
    };

    timer = setTimeout(() => {
      timer = null;
      if (utterance !== next) return;
      owner = null;
      utterance = null;
      report('retry');
    }, START_TIMEOUT_MS);

    try {
      synth.speak(next);
    } catch {
      clearTimer();
      owner = null;
      utterance = null;
      report('retry');
    }
  }

  return {
    speak,
    /** 主动停掉并退位。切视频、关词卡、组件销毁时都要调。 */
    stop() { release(); },
    /** 某个占用者还在位吗 —— 用来决定它显示 idle 还是自己该让位。 */
    owns(who) { return owner === who; },
    dispose() { release(); },
  };
}
