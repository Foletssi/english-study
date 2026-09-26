/* Eastudy V3 — 视频学习页 (M04).

   Composes the player with the services. The page owns three things the
   player deliberately does not:

   1. The media ticket lifecycle. A ticket is fetched once per video and
      renewed by the media service before it expires; the player only ever
      receives a ready playlist URL.
   2. Progress reporting. Heartbeats are debounced in the service, flushed on
      route change and on pagehide, so a learner who closes the tab mid-video
      does not lose the last fifteen seconds.
   3. The completion page and the next-lesson handoff, which is a
      `switchVideo` transaction rather than a reload. */

import { el, mount, setText } from '../../core/dom.js';
import { createPlayer, emptyState, errorState, toast } from '../../ui/index.js';
import { describeError } from '../../services/index.js';
import { EVENTS, on } from '../../core/bus.js';

export function createWatchPage({ catalog, media, progress, vocabulary, navigate, params, session }) {
  const videoId = params?.id || '';
  const slot = el('div', { class: 'watch__slot' });
  const sidebar = el('aside', { class: 'watch__sidebar' });
  const nextSlot = el('section', { class: 'watch__next' });

  const root = el('div', { class: 'page watch' },
    el('div', { class: 'watch__main' }, slot, nextSlot),
    sidebar,
  );

  let player = null;
  let current = null;
  let disposers = [];

  // A progress heartbeat must survive the tab closing. pagehide fires on both
  // navigation and backgrounding on iOS, which visibilitychange alone misses.
  function onPageHide() { progress.flushNow({ keepalive: true }); }
  window.addEventListener('pagehide', onPageHide);

  disposers.push(on('vocabulary:add', async ({ token, sentence, video }) => {
    try {
      await vocabulary.add({
        word: token.text,
        gloss: token.gloss,
        videoId: video?.id,
        sentence: sentence?.text,
        startSeconds: sentence?.start,
      });
      toast(`已加入生词本:${token.text}`, { variant: 'success' });
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }));

  disposers.push(on('vocabulary:follow', async ({ token, sentence, video }) => {
    try {
      await vocabulary.follow({
        word: token.text,
        videoId: video?.id,
        sentence: sentence?.text,
        startSeconds: sentence?.start,
      });
      toast(`已关注:${token.text}`, { variant: 'success' });
    } catch (error) {
      toast(describeError(error), { variant: 'error' });
    }
  }));

  function buildPlayer({ playlistUrl, subtitles, resumeAt }) {
    if (player) player.dispose();
    player = createPlayer({
      container: slot,
      onProgress: (update) => {
        if (!update.videoId) return;
        progress.report(update);
      },
      onSentenceChange: () => {},
      onComplete: () => showCompletion(),
      /* 词卡里的"复制"要告诉用户成没成 —— 剪贴板在非安全上下文会被拒,
         静默失败的话用户会以为复制成功了然后粘出上一次的内容。 */
      onNotify: (message, variant) => toast(message, { variant }),

      /* 返回视频库。播放器自己既没有路由也不知道来路, 所以导航由页面给。

         这里只能给路径, 给不了"后退一步": 路由是 hash 式的, navigate() 用
         `location.hash = target` 推新记录, 它不接受"回退"这种指令(传 -1 会在
         to.startsWith 上直接抛)。真要做回退得往 router 上加一个方法, 而返回键
         只在学习页出现 —— 为一次导航改路由的公开接口不划算。 */
      onBack: () => navigate('/catalog'),

      /* 「标记已学」。这条链路刻意不碰 `completed` —— 那一列由服务端从观看
         覆盖率算, 客户端只能报位置。这里写的是 learned_at, 手动声明与真实
         看完是两件事, 页面上也分开展示。

         失败必须把灯收回去: 播放器已经乐观点亮了, 不回收的话用户看到"已学完",
         刷新后又变回"标记已学", 而中间没有任何提示。 */
      onLearned: async ({ videoId, learned }) => {
        try {
          await progress.setLearned(videoId, learned);
          toast(learned ? '已标记为本课学完' : '已取消标记', { variant: 'success' });
        } catch (error) {
          player?.setLearned(!learned);
          toast(describeError(error), { variant: 'error' });
        }
      },
    });
    mount(slot, player.root);
    /* 进页时把服务端已有的标记读回来。不做这一步, 按钮永远是「标记已学」——
       而它其实是学过的, 学员会以为自己上次没点上, 然后反复点。 */
    player.setLearned(progress.isLearned(current?.id));
    return player.load({ video: current, playlistUrl, subtitles, resumeAt });
  }

  async function loadVideo(id, { resume = true } = {}) {
    /* 这一行原来是 `setText(root.querySelector('.page__title') || el('span'), '')`
       —— 但 watch 页里根本没有 .page__title 这个元素(标题在播放器自己的
       头部里)。没找到时它会把文本写进一个刚造出来、从没挂到文档上的 span,
       等于什么都没做, 只是每次切视频白造一个节点。删掉。 */
    mount(slot, el('div', { class: 'skeleton skeleton--player' }));

    let detail;
    try {
      detail = await catalog.detail(id);
    } catch (error) {
      mount(slot, errorState({ message: describeError(error), onRetry: () => loadVideo(id) }));
      return;
    }

    current = detail;

    let ticket;
    try {
      ticket = await media.ticket(id);
    } catch (error) {
      mount(slot, emptyState({
        title: '暂时无法播放',
        hint: describeError(error),
        action: el('button', { class: 'btn btn--ghost', type: 'button', on: { click: () => loadVideo(id) } }, '重试'),
      }));
      return;
    }

    let subtitles = [];
    try {
      const payload = await media.subtitles(id);
      // The route returns `{ prefix, cues }`. Reading `sentences` here meant the
      // player got an empty list on every video that had subtitles — and it
      // looks identical to a video that simply has none, so the symptom was
      // "subtitles never show up" rather than an error. The other two names are
      // kept because `sentences` is what the admin side calls the same data and
      // `segments` is what an older revision returned.
      subtitles = payload?.cues ?? payload?.sentences ?? payload?.segments
        ?? (Array.isArray(payload) ? payload : []);
    } catch {
      // A video without subtitles still plays; the player shows its empty state.
    }

    const resumeAt = resume ? progress.resumePoint(id) : 0;
    await buildPlayer({ playlistUrl: ticket.playlistUrl, subtitles, resumeAt });
    renderSidebar();
    renderNext(detail);
  }

  function renderSidebar() {
    const row = progress.get(current?.id);
    mount(sidebar,
      el('section', { class: 'side-card' },
        el('h2', { class: 'side-card__title' }, '本课信息'),
        el('dl', { class: 'side-card__list' },
          current?.level ? el('div', null, el('dt', null, '难度'), el('dd', null, current.level)) : null,
          current?.category ? el('div', null, el('dt', null, '分类'), el('dd', null, current.category)) : null,
          el('div', null, el('dt', null, '学习进度'), el('dd', null, row ? `${Math.round((row.coverage || 0) * 100)}%` : '0%')),
        ),
      ),
      el('section', { class: 'side-card' },
        el('h2', { class: 'side-card__title' }, '快捷键'),
        el('ul', { class: 'side-card__keys' },
          el('li', null, el('kbd', null, '空格'), '播放 / 暂停'),
          el('li', null, el('kbd', null, '←'), '后退 5 秒'),
          el('li', null, el('kbd', null, '→'), '前进 5 秒'),
        ),
      ),
    );
  }

  function renderNext(video) {
    const candidates = (video.next_lessons ?? []).slice(0, 4);
    if (!candidates.length) { mount(nextSlot); return; }

    mount(nextSlot,
      el('h2', { class: 'section__title' }, '接下来看'),
      el('div', { class: 'next-row' }, ...candidates.map((item) => el('button', {
        class: 'next-card', type: 'button',
        on: { click: () => switchTo(item.id) },
      },
        el('span', { class: 'next-card__title' }, item.title || '未命名'),
        el('span', { class: 'next-card__hint' }, item.subtitle || ''),
      ))),
    );
  }

  /** The switch is a transaction: the player bumps its epoch so a late
      subtitle or ticket response for the previous video cannot paint onto the
      new one. */
  async function switchTo(id) {
    progress.flush().catch(() => {});
    media.invalidate();
    history.replaceState(null, '', `#/watch/${encodeURIComponent(id)}`);
    videoId_ = id;
    mount(nextSlot);
    await loadVideo(id, { resume: true });
  }

  let videoId_ = videoId;

  function showCompletion() {
    const row = progress.get(current?.id);
    if (row?.completed) {
      toast('本课已完成', { variant: 'success' });
      return;
    }
    const next = (current?.next_lessons ?? [])[0];
    toast('恭喜完成本课', {
      variant: 'success',
      duration: 8000,
      action: next ? { label: '下一课', run: () => switchTo(next.id) } : null,
    });
  }

  return {
    root,
    async mount() {
      if (!videoId) {
        mount(slot, emptyState({ title: '没有指定视频', hint: '请从视频库中选择一个视频。' }));
        return;
      }
      await loadVideo(videoId);
    },
    unmount() {
      progress.flush().catch(() => {});
      if (player) { player.dispose(); player = null; }
      window.removeEventListener('pagehide', onPageHide);
      for (const dispose of disposers) { try { dispose(); } catch {} }
      disposers = [];
    },
    get videoId() { return videoId_; },
  };
}
