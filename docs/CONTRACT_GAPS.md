# 学员端 ↔ 控制端 契约缺口清单

这是"学生端和控制端的映射也要做一个对应的检查。保证逻辑通路的正常"这项要求的
执行记录。方法:把 `src/services/` 里客户端实际发出的每一个请求,和
`functions/api/` 里实际存在的处理函数逐条比对,包括**路径**、**查询参数名**、
**请求体字段名**和**响应字段名**四项。

比对结果分三类。第一类是还没写的接口(清单在最后,属于未完成,不是缺陷);
前两类是**已经写好的代码之间对不上**,这类才是真正的通路断点。

---

> **状态(本次已全部修复。)** 下面 G-01、G-05、G-06 三条都已在代码里改完,
> 保留原始描述是为了留下"这类断点长什么样"的记录 —— 三条都是不报错的那类。
> 修复清单见第五节。

## 一、参数名不匹配(页面会静默给出错误结果)

### G-01 分页参数:客户端发 `page`/`pageSize`,服务端读 `limit`/`offset`

- 客户端:`src/services/catalog.js`、`admin-videos.js`、`learners.js`、`jobs.js`
  全部通过 `api.get(path, { query: { page, pageSize, ... } })` 传参。
- 服务端:`functions/api/catalog.js` 读的是 `limit` 和 `offset`;
  `functions/api/admin/videos/index.js` 读的也是 `limit` 和 `offset`。
- 后果:`page=3` 不在服务端读取的参数里,`limit` 缺失时回落到默认值。
  **学员端翻到第 3 页拿到的仍然是第 1 页的 24 条**;控制端视频列表同理。
  没有报错、没有空列表,只是数据不对 —— 这是最难被发现的一类断点。
- 修法:服务端统一接受 `page`/`pageSize`,并在内部换算成 PostgREST 的
  `limit`/`offset`;同时保留 `limit`/`offset` 以兼容直接调 API 的脚本。
  换算逻辑放进 `_lib/paging.js`,一处实现。

  修复过程里发现这条比原本记的更宽:它和 G-05 是同一个原因的两个后果。
  三个端点没迁移,所以既认不出 `page`,也不返回 `total`;而
  `createListController` 算的是 `total: result.total ?? 0`,`0 > pageSize`
  恒为假 —— **三个列表页的分页器从来就没有渲染过**,不只是页码不对。

  已迁移到 `_lib/paging.js` 的三个端点:`catalog.js`、`admin/videos/index.js`、
  `admin/jobs/index.js`。加上原有的 `admin/learners`、`admin/invite-codes`、
  `plans`,现在全部列表端点共用一套词汇。

  迁移前确认过没有破坏性:全仓 grep `.limit` / `.offset` / `.hasMore`,
  客户端没有任何一处读这三个字段,只读 `total` 和 `pageSize`。

### G-02 媒体凭证:请求体字段名不同

- 客户端:`src/services/media.js` 发 `{ video_id }`。
- 服务端:`functions/api/media/[[path]].js` 的 POST 读 `body.videoId`。
- 后果:`videoId` 恒为 `undefined` → 抛 `400 VIDEO_ID_REQUIRED`。
  **整个学员端播放功能不可用**,而错误信息会显示成"缺少视频 ID",让人以为
  是数据问题而不是字段名问题。
- 修法:两种拼写都接受(客户端统一 snake_case,兼容手写 curl)。
  已在 `functions/api/media/ticket.js` 落实。

### G-03 媒体凭证:响应字段名和结构不对

- 客户端 `media.js` 需要:`{ ticket, expires_at, playlist_url, subtitles_url, qualities }`。
- 原服务端返回:`{ ticket, prefix, playlist }`,缺 `expires_at`、`subtitles_url`、
  `qualities`,且视频地址的键名是 `playlist` 不是 `playlist_url`。
- 后果:`new Date(undefined).getTime()` 得到 `NaN`,缓存判断
  `cached.expiresAt - Date.now() > RENEW_MARGIN_MS` 恒为 `false`,
  **每一句字幕拖动都重新申请一次凭证**;`playlist_url` 为 `undefined` 时
  播放器无法起播。
- 修法:见 `functions/api/media/ticket.js`,`expires_at` 由票据的 `exp` 反算,
  保证客户端看到的过期时间和签名里的一致。

### G-04 字幕:客户端先试 URL,再回落到接口

- 客户端 `media.js` 的 `subtitles()` 会先 `fetch(entry.subtitlesUrl)`,
  失败后回落到 `GET /api/media/subtitles/:videoId`。
- 原服务端既没有 `subtitles_url`(见 G-03),也没有字幕子路由,
  两个分支都会失败,播放器右侧永远渲染不出字幕。
- 修法:`subtitles_url` 指向 `/api/media/subtitles/<prefix>`,
  由 `functions/api/media/[[path]].js` 处理。注意字幕按 **prefix** 寻址、
  按 **videoId** 寻址是两回事,服务端以 prefix 为准,因为票据签的也是 prefix。

---

## 二、已发现但需确认的次要不一致

### G-05 列表响应缺少总数

- 客户端 `createListController` 依赖响应里的 `total` 来渲染分页器。
- 服务端目前只返回 `rows`、`limit`、`offset`,`hasMore` 只在 catalog 里有。
- 修法:所有列表接口统一返回 `{ rows, total, page, pageSize, hasMore }`。
  `total` 取自 PostgREST 的 `Content-Range` 响应头。原实现在
  `admin/videos/index.js` 里设了 `Prefer: count=exact` 但从未读这个头,
  等于白设。

  已修复。三处都改成 `client.call(...)` + `readTotal(response, rows)` ——
  必须用 `call` 而不是 `select`,因为 `select` 只把数组交回来,响应头在
  这一层就已经丢了。

  另外补了一个上面没记、但属于同一处的缺陷:**`/api/admin/jobs` 从来没
  返回过 `counts`**。队列页顶部的"排队中 / 处理中 / 失败"读的是
  `counts.WAITING / RUNNING / FAILED`,客户端从第一天起就这么读,服务端
  从第一天起就没发过 —— 所以那三个数字一直是 0,而下面列着一堆任务。
  现在用三次 `limit=0` + `count=exact` 的只读头请求算出来(不拉行,
  不随页码变化)。同一页里还顺手让它认 `stalled=true` 和 `pipeline`。

  `counts` 不在 `createListController` 搬运的字段里(它只搬 `rows`/`total`),
  所以队列页自己存了一份,由翻页和轮询两处共同更新 —— 否则摘要栏要等到
  第一次轮询(8 秒后)才有数。

### G-06 控制端 jobs 轮询把页码重置为第 1 页

- `src/admin/pages/jobs.js` 的轮询回调写死了 `page: 1`。
  操作员在第 3 页查看任务时,每 8 秒被拽回第 1 页。
- 修法:轮询保留当前页码和筛选条件。

  已修复,并且比原记录多一处:`src/services/jobs.js` 的 `startPolling` 里
  同样写死了 `page: 1` **且丢掉了筛选条件**(`stalled`)。也就是说即使页面
  回调改对了,轮询自己发出去的请求仍然是无筛选的第 1 页。现在由 `list()`
  记录最近一次实际请求的参数(`lastParams`),轮询复用它。

  同一处还把 `last.videos` 改成了 `last.rows`:这个 service 是唯一一个
  自己留一份响应副本的列表客户端,而它留的字段名和服务端统一后的信封
  对不上,`summary().stalled` 因此恒为 0。

---

## 三、接口实现状态(已全部落地)

这一节原本列的是"还没写的接口"。现在客户端 `src/services/` 发出的每一个请求
都能在 `functions/api/` 找到对应处理函数,待实现数量为 **0**。保留此节是因为
通路检查的输出里仍会显示"存在待实现接口"这一句 —— 那是测试里写死的字符串,
不是实际结果,修法见第五节。

| 端点 | 对应模块 |
| --- | --- |
| `GET/POST /api/progress` | M05 |
| `GET/POST /api/vocabulary`、`/follow`、`/:id` | M06 |
| `GET /api/plans`、`POST/PATCH/DELETE /api/plans/:id` | M05 |
| `GET/PATCH /api/profile` | M01 |
| `POST /api/invite-codes/redeem` | M01 |
| `GET /api/media/preview` | M07 |
| `GET/PUT /api/admin/subtitles/:id` | M07 |
| `POST /api/admin/videos/:id/source-received` | M07 |
| `POST /api/admin/videos/:id/archive-reason` | M07 |
| `GET /api/admin/learners`、`/:id`、`POST /:id/vip` | M09 |
| `GET/POST /api/admin/invite-codes`、`DELETE /:code` | M09 |
| `GET/PUT /api/admin/settings`、`/ai` | M10 |
| `GET /api/admin/settings/worker` | M10 |
| `GET /api/admin/jobs`、`/api/admin/jobs/:id` | M08 |
| `GET /api/admin/dashboard` | M10 |

注意 `POST /api/admin/videos/:id/source-received` 和 `archive-reason` 两个端点写入
的 `source_bytes`、`source_name`、`source_received_at`、`archive_reason` 四列
**在 schema 里是否已存在尚未核对**。处理函数对 `PGRST204`(未知列)和 `42703`
做了兜底,缺列时降级而不是 500,所以接口可用;但要在数据库侧真正留下这四个值,
需要补 `supabase/migrations` 里的列。

---

## 三之二、音频衍生文件约定(流水线 → 边缘函数)

`GET /api/media/preview` 试听用的是**处理阶段产出的一份独立音频文件**,不是从
视频里实时切一段。这条约定跨了两个仓库,写在这里是因为两边要同时改:

**流水线侧(本仓库之外,`services/intake/` 与转码 worker):**

处理视频时,在视频自己的 `playback_prefix` 下、与媒体文件并列,额外导出一个:

| 项 | 值 |
| --- | --- |
| 键名 | `{playback_prefix}/audio.m4a` |
| 容器 / 编码 | MP4 容器 + AAC |
| 码率 | 约 64 kbps(试听用途,不需要更高) |
| 声道 | 单声道即可 |

只需要这一件事:一次转码顺手导出。不需要额外请求、不需要新的队列任务、
不需要回写 `videos` 表的任何列 —— `preview.js` 是按 `playback_prefix` 直接去
R2 找这个键的,没找到就是 404。

**边缘函数侧(`functions/api/media/preview.js`):**

- 取 `videos.playback_prefix`,依次尝试 `audio.m4a` → `audio.aac` → `audio.mp3`。
  后两个是给约定生效**之前**已经处理过的视频留的退路,不是为了支持三种格式。
- 没有任何一个存在时返回 `404 AUDIO_NOT_FOUND`,消息为
  "该视频没有音频文件,请确认处理流程已生成 audio.m4a" —— 操作员看到的就是
  该去改什么。
- 支持 `Range` 请求(206 + `Content-Range`),因为页面靠 `currentTime` 定位。
- 认证方式与控制端其他接口一致(`requireAdmin`),**不是**签名 ticket。
  原因见文件头注释:审核发生在视频还是草稿的时候,而 `/api/media/ticket`
  对非 PUBLISHED 的视频一律 403,用 ticket 卡这条路由会让审核页面恰好对
  最需要审核的视频不可用。

**在 worker 更新之前,试听按钮会返回 `404 AUDIO_NOT_FOUND`。** 这不是前端缺陷。

---

## 四、检查方式

`tests/contracts/` 下的测试把上面这套比对固化成可重复执行的断言:
从 `src/services/` 里抽出所有请求路径和参数名,从 `functions/` 的目录结构
推导出所有可用路由,两者做差集。任何一边改了名字而另一边没跟上,测试直接失败。

这比人工核对可靠的地方在于:它检查的是**实际代码**,不是文档 ——
文档会过期,而文档过期正是这个项目走到今天这个状态的原因之一。

### 报告层缺陷(本次已全部修掉)

以下三处只影响你从输出里读到的结论,不影响断言本身。它们此前会让人误判
"还有活没干完",或误判"某个断链还不存在":

1. **结尾那句结论字符串是写死的。** 无论实际结果如何都打印
   `结果:通过(存在待实现接口,非断链)`,而待实现数量当时已经是 0。
   现在结论由实际计数推导,分三种写法:全通、有 `N` 条待实现、未通过并列出原因。
2. **`--strict` 是空转的。** `strict && pending.length > 0` 这个判断没有产生
   任何效果。现在 `--strict` 真的会让待实现端点失败退出(实测 `2>0` 与 `>0` 两
   条分支都走过)。真正该拦的 `broken` 本来就在拦。
3. **`PENDING` 映射表过期。** 表里 24 条端点全部已实现,于是它只会把
   "实现了"报成"待实现"。现在改为**调用点标注**:待实现的调用在写它的那个文件里
   标 `待实现`,测试读那条调用的源文件。标注紧挨着它豁免的那行代码,不会像手写表
   那样和代码脱节。

### 新增:catch-all 兜底的识别

`[[path]]` 是 `[[path]].js` 的服务对象,`/api/plans/<id>` 落到 `[[path]].js`
是**对的**。早先按"没有同名专用文件"来报,一口气报出 14 条合法调用,全是噪音。

现在只报真正的兜底:调用方写了**字面量**段,而吞掉它的那个 catch-all 文件里
从没提过这个词 —— 那正是"专用文件缺失"的形态,请求会进 catch-all 的 handler,
返回一个读起来像服务端故障的 404。当前为 0 条。

顺带修掉两处我自己引入的假信号:`templated` 标志最初从替换**前**的字符串算
(`${id}` ≠ `:p`),把所有模板洞都判成字面量;`absorbed` 的判断又对整条路径取
"是否含字面量",而 `api`/`admin` 这类前缀本来就是字面量,于是恒为真。两处都
改成只看被 `**` 吞掉的那几段。

---

## 五、这次改到的文件

| 文件 | 改动 |
| --- | --- |
| `functions/api/admin/subtitles/[[path]].js` | 新建:字幕读写,revision CAS,冲突时回读真实版本 |
| `functions/api/media/preview.js` | 新建:试听音频,by range,`requireAdmin` |
| `src/services/media.js` | 新增 `preview()`(blob URL 缓存)与 `invalidate` 里的释放 |
| `src/admin/pages/subtitles.js` | 试听改为单元素复用 + token 守卫,`unmount` 清理 |
| `src/core/http.js` | 新增 `withQuery`,让 `query` 真正拼进 URL |
| `src/services/api.js` | `query` / `timeoutMs` / `parse` 三个参数原来都没传到底 |

### 学员详情页(补一个不存在的路由)

| 文件 | 改动 |
| --- | --- |
| `src/admin/pages/learner-detail.js` | 新建:学员列表的「详情」按钮此前指向一个从未注册的路由,落到 fallback 弹回 `/admin`;而 `/api/admin/learners/:id` 一直在正常返回数据 |
| `src/app/admin-main.js` | 注册 `/admin/learners/:id`(路由按段数匹配,`:id` 不会吞掉列表路由) |
| `public/assets/admin.css` | 学员详情样式;`.is-unknown` 让"数字未知"和"数字是 0"看起来不一样 |

### 分页词汇统一(G-01 / G-05 / G-06)

| 文件 | 改动 |
| --- | --- |
| `functions/api/catalog.js` | 迁移到 `readPaging`/`readTotal`/`listResponse`;`Prefer: count=exact` 现在真的被读了 |
| `functions/api/admin/videos/index.js` | 同上 |
| `functions/api/admin/jobs/index.js` | 同上,并新增 `counts`、`stalled=true`、`pipeline` 三个响应/查询项 |
| `src/services/jobs.js` | `last.videos` → `last.rows`;轮询改为复用 `lastParams`(页码 + 筛选),不再写死第 1 页 |
| `src/admin/pages/jobs.js` | 轮询回调读 `result.rows`/`result.page`;`counts` 由页面持有,翻页与轮询共同更新 |
| `functions/api/admin/learners/[[path]].js` | 新增 `withTitles`:一批查询给全部学习记录补视频标题 |
| `src/admin/pages/learner-detail.js` | 删掉页面侧那次错误的标题补全调用(见下) |

标题补全挪到服务端的原因不是洁癖:页面当时写的是
`videos.list({ page: 1, pageSize: 200 })`,而这个端点只认 `limit`/`offset` ——
正是 G-01 本身。它拿不到 200 条,只会静默返回默认的一页,于是表里一部分行
显示标题、其余显示 uuid。这类"部分正确"比全错更难看出来,所以改成服务端
按 id 集合一次查完(`plans/index.js` 里已有同样的先例)。

### 契约测试(报告层)

| 文件 | 改动 |
| --- | --- |
| `tests/contracts/student-admin-mapping.mjs` | 结论字符串改为推导;`--strict` 生效;删掉 24 条过期 `PENDING` 表,改为读调用点标注;新增 catch-all 兜底识别;`dedupe` 提前到循环之前 |
| `tests/contracts/route-map.js` | `collectClientCalls` 新增 `templated` 标志(从替换后的路径算),供兜底判断区分"模板洞"与"字面量" |

---

## 六、启动即白屏的三个阻塞(本次修掉)

这三个都不会被构建或类型检查发现,只在浏览器里表现为白屏。

### B-01 `env.js` 与 `environment.js` 键名不一致

| | |
| --- | --- |
| 现象 | 两个入口都渲染致命错误页 |
| 原因 | `env.js` 写的是 `supabaseAnonKey` / `apiBase`,`environment.js` 读的是 `supabasePublishableKey` / `apiBaseUrl`。`assertSafeEnvironment()` 因此永远抛「未配置」 |
| 修法 | 统一为 `environment.js` 的键名;`tools/build.mjs` 的写入表同步改名(写不到就中止构建);新增 `tests/unit/environment.test.mjs` 断言两侧键名集合一致 |

没有任何构建步骤能发现"同一个名字写了两遍、拼错一遍",所以只能靠断言。

### B-02 `globalThis.supabase` 从未加载

| | |
| --- | --- |
| 现象 | `src/services/auth.js` 一加载就 `undefined` |
| 原因 | 两个 HTML 都没有 supabase-js 的 `<script>`;`src/services/auth.js:38` 直接读 `profiles` 表,依赖这个全局 |
| 修法 | 两个外壳各加 `/env.js` 与 `/assets/vendor/supabase.js`,且**不用 `defer`** —— `defer` 与 module 队列的交错顺序是实现细节,赌错就是首屏 `supabase is not defined` |

### B-03 `media_profile` 有三套词表

| | |
| --- | --- |
| 现象 | 管理员保存播放规格被 400;或存下一个没有编码器产出的档位 |
| 原因 | `settings/index.js` 允许 `360p`…`2160p` 并默认 `1080p`;设置页只给 `balanced-540-v1`;`ticket.js` 签发的 id 来自 `MEDIA_PROFILE` 环境变量 |
| 修法 | 新建 `functions/_lib/profiles.js` 作为唯一词表;`settings/index.js` 与 `ticket.js` 都改为引用它 |

收敛过程中先写了一个"接受旧式分辨率写法"的兼容分支,复查时删掉了:它接受的每一个分辨率(360p/720p/1080p)都对应一条没有部署会产出的编码档,等于把这次要消掉的毛病又放回库里。现在库里的旧值读出来即被判定为不认识、回落到默认,自愈而不需要数据迁移。

顺带修掉的还有 `ticket.js` 的质量标签硬编码 `'540P'`,而 id 来自环境变量 —— 改了 `MEDIA_PROFILE` 就会出现"标签写着 540P、指向另一个档位"。

---

## 七、其它缺陷(本次修掉)

| 文件 | 改动 |
| --- | --- |
| `functions/api/progress.js` | `completed_at` 被写但不在 select 列表里,`prior.completed_at` 恒为 `undefined`,于是每次心跳都用 `?? null` 把完成时间覆盖成 NULL。已加进 select |
| `src/config/environment.js` | 删掉 `FALLBACK.environment` —— 它永远被 `...raw` 覆盖,读起来像个真默认值,实际是死字段 |
| `public/_headers` | 新建;CSP 的两个内联脚本哈希用真实字节算出(两个外壳的内联脚本是同一段,所以只有一个哈希) |

---

## 八、交付脚手架(本次新建)

| 文件 | 说明 |
| --- | --- |
| `supabase/migrations/0001_init.sql` | 15 张表、索引、唯一约束、RLS、`on_auth_user_created` 触发器、分类与设置种子。**每个唯一约束都注明了依赖它的调用点** |
| `public/_routes.json` | 只有 `/api/*` 进 Functions,静态资源与 `/env.js` 走边缘缓存 |
| `public/_headers` | 安全头 + CSP;HTML 外壳与 `env.js` 不缓存(缓存住就会在部署后拿着旧的 chunk 名去取) |
| `wrangler.toml` | `nodejs_compat`(票据签名需要 HMAC)、Pages 输出目录、R2 绑定、必需变量清单 |
| `.gitignore` | `dist/`、`node_modules/`、`.dev.vars`、`runtime/` |
| `tools/dev.mjs` | 构建 + `wrangler pages dev` + 本机接收服务,并提示缺失的 `.dev.vars` |
| `README.md` | 部署顺序、两套环境变量、安全边界、已知待办 |
| `tests/unit/sha256.test.mjs` | 标准向量 + 填充边界(55/56/63/64)+ 分块 update 一致性 |
| `tests/unit/environment.test.mjs` | 键名配对、多余键、服务端密钥泄漏、回环地址约束 |

迁移里有两条刻意的"不约束":`processing_jobs.stage` 与 `worker_heartbeats.status` 的写入方是 `services/worker`(不在本仓库),本仓库只读不写,看不到取值集合,加 CHECK 就是拿生产去赌一个猜测。

---

## 九、Pages 路由阴影与发布树(两处实测记录)

这一节记的都是**引擎行为**,不是本仓库的业务逻辑。写下来的原因相同:两处
都曾经"看起来是对的",而唯一的判据是量出来,不是推出来。

### R-01 `[[path]].js` 会吞掉零个段,所以它和 `index.js` 不能同目录

Cloudflare Pages 的 catch-all 文件名是 `[[path]].js`。此前我(和这份文档的
前一版注释)都按"catch-all 至少要吸收一段"来理解 —— 也就是说它只为
`父路径/xxx` 服务,父路径本身由 `index.js` 应答。

**这是错的。用 `wrangler pages dev` 加一个把自身文件名写进响应头的探针实测:**

| 请求 | 实际落到 |
| --- | --- |
| `/api/probe` | `probe/index.js` |
| `/api/probe/abc` | `probe/[id].js` |
| `/api/shadow` | **`shadow/[[path]].js`** ← 同目录的 `index.js` 从不执行 |
| `/api/shadow/abc` | `shadow/[[path]].js` |

`[id].js` 与 `index.js` 并存是**正常**的,两者都按预期被调用;`[id].js` 与
同名目录 `[id]/` 并存也正常。有问题的只有 `index.js` + `[[path]].js` 这一种
组合,而且失败方式很安静:`index.js` 是死代码,没有任何东西会报错。

本仓库曾**六个目录**是这种排布。其中五个的 catch-all 恰好因为别的原因返回
401,于是"列表接口返回了一个合理的错误"看起来像个权限问题,**而不是**
"列表接口压根没被调用"。`functions/api/catalog` 没有这层掩护 ——
它的 catch-all 调了 `requireUser` 而 index 路由不调 —— 于是一个公开端点开始
要 token。这就是它被发现的原因,而不是因为有人读注释读出了矛盾。

改法是把这六个 `[[path]].js` 挪到 `[id].js`(或删掉,让前缀独占)。

### R-02 契约测试按构造看不见 R-01

`tests/contracts/route-map.js` 的 `matches()` 里有一行
`if (catchAllAt !== -1 && clientParts.length <= catchAllAt) return false;`,
它编码的正是"catch-all 至少吸收一段"这个被推翻的信念。

后果比"少报一个错"严重:测试从文件系统推导路由表,**推出来的表是对的**
(每个文件都在表里),只是表里哪一行在实际部署中会被调用是错的。于是
六个被遮蔽的路由一路绿灯 —— 断言检查的是表,不是路由。

这行现在还在,但只是**建模取舍**,注释已改成说明它为什么不能当文档读。
真正的防线是 `tests/unit/syntax.test.mjs` 里那条**文件系统检查**:
同一个目录里出现 `index.js` 和 `[[path]].js` 就失败。这条断言不依赖任何人
对引擎的看法 —— 而"两个文件、一个目录"恰好就是这个缺陷本身的形状。

### R-03 `dist/functions/` 会被当成静态资源公开

`tools/build.mjs` 原来把 `functions/` 复制进 `dist/`。这个复制**既多余又漏**:

- **多余**:`wrangler pages deploy` 从 `<cwd>/functions` 读 Functions。
  wrangler 自己的上传路径里那行兜底写得很清楚 ——
  `customFunctionsDirectory || join(process.cwd(), "functions")` ——
  **没有任何一处会去问 `dist/`**。实测:把 `dist/functions/` 整个移走,
  `wrangler pages dev dist` 仍然从根目录那份提供 `/api/catalog`。
- **漏**:`public/_routes.json` 的 `include` 只有 `/api/*`,所以
  `/functions/**` **永远不会**被交给 Worker;它落到静态资源那一侧并被发布。
  `_lib/` 里的后端源码(含查询构造器)在可预测路径上可下载。

  里面没有密钥 —— 密钥是 dashboard 环境变量,从来不是文件 —— 但后端源码没有
  理由随包体一起发出去。

#### 判断这件事花了三步,记下来是因为前两步都是错的

**第一步(错)**:看到 `GET /functions/_lib/env.js 200 OK`,判定泄露。
**第二步(错,且是我主动纠正的错)**:把 `dist/functions/` 移走后这个 200
还在,于是判定第一步错了、没有泄露。**第三步(对)**:`diff` 了两边的响应体,
发现那是 **SPA 外壳 HTML**;再打一个随机路径 `/totally/random/path.js`,
同样 200 `text/html`。

也就是说**两次读到的都不是证据**。`_routes.json` 之外的任何未匹配路径都会
返回 200 + 外壳,状态码在这个仓库里没有区分能力。真正的判据是
**`Content-Type` 与响应体本身**:

| 请求 | 状态码 | Content-Type | 响应体 |
| --- | --- | --- | --- |
| `/functions/_lib/canary.js`(文件真实存在) | 200 | `application/javascript` | `LEAK-CANARY-9137` |
| `/functions/_lib/nope-canary.js`(不存在) | 200 | `text/html; charset=utf-8` | 外壳 |

结论:**R-03 成立**,第二步那次"纠正"本身才是错误的。

#### 现在的两道闸

1. `tools/build.mjs` 的 `assertClean()` —— 构建后检查 `dist/` 里没有
   `FORBIDDEN_IN_OUTPUT` 列出的目录,有则构建失败并说明原因。
   **实际效力有限,必须讲清楚**:`main()` 第一行就 `rm -rf dist`,
   所以它**抓不到构建前就已经存在的污染**,只能说"这次构建没有产生它"。
   实测:手工往 `dist/functions/` 塞文件再 `npm run build`,退出码 0,
   污染消失 —— 是第一步的清理干的,不是断言。断言逻辑本身另外单独验过
   (退出码 1,消息正确)。
2. `tests/unit/output.test.mjs` —— 检查构建产物本身。需要它的原因是
   **两道闸里只有一道总会跑**:跳过 `npm run build`、直接上传现成 `dist/`
   的部署永远到不了构建期那道。该文件在 `dist/` 不存在时 **skip 而非 fail**,
   因为 `npm run check` 里 `test` 排在 `build` 前面,首次干净检出时
   `dist/` 本来就还没有。

第二道闸同时断言 `dist/env.js` 里没有 service_role 形态的密钥(以 `eyJ`
开头且长于 200 字符),读的是**构建产物**而不是源文件 —— 源文件不是上线的那份,
`writeEnv()` 会用环境变量重写每一个值。
