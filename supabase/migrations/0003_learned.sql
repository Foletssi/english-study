-- Eastudy V3 — 0003: 学员手动「标记已学」的落点
--
-- 为什么需要单独一列, 而不是复用 learning_progress.completed:
--
-- `completed` 是**算出来的**, 由 functions/api/progress.js 从 watch_ranges
-- 合并后的覆盖率决定 (best >= 0.9)。它的整个价值在于不可伪造 —— 0001 建表时
-- 专门把 watch_ranges 存成区间数组而不是一个"最远位置", 就是为了让拖进度条
-- 跳到结尾这件事不算看完。
--
-- 播放器底栏那一键「标记已学」是另一回事: 它是学员**主动的声明** ——
-- "这一课我不打算再看第二遍了"。这两件事在业务上都必须存在, 而且必须能区分:
-- 后台概览的「完成率」只能读 completed, 一旦让按钮写进那一列, 完成率就变成
-- 一个学员可以自己点上去的数字, 看板也就同时失去了意义。
--
-- 所以手工标记进 learned_at, 一个时间戳:
--   NULL  = 没标记
--   时间  = 标记的时刻 (取消时置回 NULL)
-- 用时间戳而不是 boolean, 因为"什么时候标的"以后要用于「本周复习过多少课」
-- 这类统计, 而 boolean 之后想加时间得再开一次迁移。
--
-- 两个列之间**没有**派生关系: 手动标记不会把 completed 置真, 覆盖率达标也
-- 不会自动写 learned_at。前端两者分开显示, 不做归一。

begin;

alter table public.learning_progress
  add column if not exists learned_at timestamptz;

comment on column public.learning_progress.learned_at is
  '学员手动标记「已学完」的时刻; NULL 表示未标记。与 completed 无关 —— completed 由 watch_ranges 的覆盖率算出, 客户端不可写。';

-- 0001 里 idx 走的是 (user_id, updated_at desc), 服务于"最近在学习"。
-- 这一条服务于「我标记过哪些课」—— 部分索引, 因为绝大多数行的 learned_at
-- 是 NULL, 把它们排除掉索引就只和真正标记过的行成正比。
create index if not exists learning_progress_learned_idx
  on public.learning_progress (user_id, learned_at desc)
  where learned_at is not null;

commit;

-- 部署说明: 这一列是客户端可写的, 但**只能写自己的行**。0001 里
-- learning_progress_own 这条策略是 `for all using (auth.uid() = user_id)
-- with check (auth.uid() = user_id)`, using 管读、with check 管写, 所以
-- 越权的 upsert 会在 with check 上被拒, 不需要为这一列另加策略。
