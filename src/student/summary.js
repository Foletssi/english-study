/* Eastudy V3 — 学习概览的小结.

   首页上"今天/本周"这块以前没有,而它是回访用户最想先看到的一句话:
   我今天动过没有,这周铺开了几课.

   这里刻意**不算学习时长**. 进度行里只有 `position_seconds`(当前播放位置)
   和 `updated_at`(最后一次写入时间),没有任何一处记录"累计观看秒数" ——
   同一条记录被写十次也只留最后一次的位置. 拿位置差去凑时长, 会得出
   "看到 10 分钟 = 学了 10 分钟"这种账, 拖一次进度条就多出一个小时的假数据.
   与其显示一个编出来的数字, 不如显示一个真的: 动过几个视频.

   也刻意**不做连续打卡**. 连续天数是把人绑回产品的机制, 不是帮人学东西的
   机制; 断一天就归零的设计会让本来只想歇一天的人直接放弃. 这里只回答
   "这周做了什么", 不回答"你欠了多少". */

const DAY_MS = 86_400_000;

/* 时区必须显式给定: 学员在国内, 而服务端时间戳是 UTC. 用本机时区算,
   一个在 UTC+0 的浏览器上跑的测试会得到和用户看到的不同的"今天" ——
   "今天"这个词的边界是用户所在的那一天, 不是服务器那一天. */
const DEFAULT_ZONE = 'Asia/Shanghai';

/** `2026-09-25` —— en-CA 的输出恰好是 ISO 的日期部分, 省掉手写补零. */
function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** 把某个时刻归到它所在那一周的周一 (中文习惯: 周一是一周的第一天). */
function weekStartKey(date, timeZone) {
  const key = dayKey(date, timeZone);
  const [y, m, d] = key.split('-').map(Number);
  // 用 UTC 构造来算星期几: 这一步只做日历算术, 不涉及时刻, 所以借 UTC 的
  // 午夜可以避免又引入一次本地时区偏移.
  const asUtc = Date.UTC(y, m - 1, d);
  const weekday = new Date(asUtc).getUTCDay(); // 0=周日
  const backToMonday = (weekday + 6) % 7;
  return dayKey(new Date(asUtc - backToMonday * DAY_MS), 'UTC');
}

/**
 * 把进度行汇总成首页要显示的三个数字。
 *
 * 一条记录的"归属日"是它的 `updated_at` —— 这是这些行里唯一的时间信息,
 * 也是唯一诚实的答案: 我们知道它最后一次被写是在什么时候, 仅此而已.
 * 因此"今天动过 3 个"的准确含义是"有 3 个视频的进度在今天被写过".
 *
 * @param {Array<{updated_at?: string, completed?: boolean}>} rows
 * @param {Date} [now] 注入用于测试; 默认取当前时刻
 * @param {string} [timeZone] IANA 时区名
 */
export function summarize(rows, now = new Date(), timeZone = DEFAULT_ZONE) {
  const empty = { today: 0, week: 0, weekCompleted: 0, hasAny: false };
  if (!Array.isArray(rows) || !rows.length) return empty;

  const todayKey = dayKey(now, timeZone);
  const thisWeekKey = weekStartKey(now, timeZone);

  let today = 0;
  let week = 0;
  let weekCompleted = 0;
  let hasAny = false;

  for (const row of rows) {
    if (!row) continue;
    const stamp = row.updated_at ? new Date(row.updated_at) : null;
    // 解析不出来的时间戳不参与按日统计 —— 归到"今天"会让数字凭空虚高,
    // 而用户看到的是一个解释不了的增量.
    if (!stamp || Number.isNaN(stamp.getTime())) continue;
    hasAny = true;

    const key = dayKey(stamp, timeZone);
    const inWeek = key >= thisWeekKey;
    if (inWeek) {
      week += 1;
      if (row.completed) weekCompleted += 1;
    }
    if (key === todayKey) today += 1;
  }

  /* `hasAny` 和三个计数是两回事: 一个三周没来的老学员, 计数全是 0 但他是
     有进度的. 首页要靠它区分"还没开始"和"这周还没来" —— 前者该引导去看
     视频库, 后者不该被当成新用户那样推销一遍. */
  return { today, week, weekCompleted, hasAny };
}

/** 首页那一行文案。数字为 0 时说的是"这周还没开始",而不是一个 0。 */
export function summaryLine({ today, week, weekCompleted }) {
  if (!week && !today) return '这周还没开始,挑一个看起来不难的就行。';
  const parts = [];
  if (today) parts.push(`今天动了 ${today} 个`);
  parts.push(`这周 ${week} 个`);
  if (weekCompleted) parts.push(`完成 ${weekCompleted} 个`);
  return `${parts.join(' · ')}`;
}
