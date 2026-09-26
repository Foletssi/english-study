# 部署交接说明（Eastudy V3）

这份文档是给**执行部署的人**看的。README 讲的是项目结构，这份讲的是「按什么顺序做、哪一步不做会坏、做完怎么确认没坏」。

先读一句话结论：**这个包体的代码是完整的，但部署不是一步，是七步。其中第 1、2、3 步不做，网站能打开、能登录、能看到界面 —— 但一个视频都播不了，进度一条都存不下，而且不会有任何报错提示你。**

---

## 零、部署前必读：五个会让站点「看起来正常但实际不可用」的坑

| # | 坑 | 不处理的后果 |
|---|---|---|
| 1 | `wrangler.toml` 里 `[[r2_buckets]]` **整块是注释掉的** | `/api/media` 返回 500。**所有视频都播不了**。页面无异常，只是点播放没反应 |
| 2 | README 曾只写了 `0001_init.sql` | 漏 `0003` → `/api/progress` 整个 500，学员端首页与学习页全空；漏 `0002` → worker 永远抢不到任务，且**静默无错** |
| 3 | `env.js` 由构建脚本重写，靠 `EASTUDY_*` 六个环境变量 | 变量没设 → 构建**照样成功**，但写出一个全是空串的 `env.js`，站点启动即白屏报配置错误 |
| 4 | 仓库没有配置 git 身份 | 第一次 `git commit` 直接失败 |
| 5 | `.claude/` 目录没被 ignore | `git add -A` 会把本机绝对路径一起传上 GitHub |

第 1、2、3 条是这个项目里唯一三个「不报错地坏掉」的地方。其余问题都会当场报错，反而好办。

---

## 一、数据库（Supabase）

在 Supabase SQL 编辑器里**按文件名顺序**执行 `supabase/migrations/` 下的全部三个文件：

| 文件 | 建什么 |
|---|---|
| `0001_init.sql` | 15 张表、索引、唯一约束、RLS 策略、分类与设置默认值，末尾建 `on_auth_user_created` 触发器 |
| `0002_worker.sql` | `processing_jobs`、`worker_heartbeats`，以及 `worker_claim_job` / `worker_renew_lease` 等函数 |
| `0003_learned.sql` | `learning_progress.learned_at` 列 |

顺序不能颠倒（`0002` 依赖 `0001` 的表）。用 `supabase db push` 也可以，只要三个文件都在。

**验证**：执行完后在 SQL 编辑器里跑一句，应该返回 15（或更多）：

```sql
select count(*) from information_schema.tables where table_schema = 'public';
```

再确认函数在：

```sql
select proname from pg_proc where proname like 'worker_%';
```

---

## 二、R2 存储桶（Cloudflare）

1. 已创建 APAC location hint 的 R2 桶 `eastudy-v3-media-hk`；不要改用旧桶。
2. 打开根目录的 `wrangler.toml`，确认 R2 绑定已启用，并确认桶名对得上：

```toml
[[r2_buckets]]
binding = "PROCESSING_BUCKET"
bucket_name = "eastudy-v3-media-hk"
preview_bucket_name = "eastudy-v3-media-hk"
```

`binding` 必须**原样**是 `PROCESSING_BUCKET` —— 代码里按这个名字取绑定，改名则 `env.PROCESSING_BUCKET` 为 `undefined`，`/api/media` 报错。

**验证**：部署后访问 `/api/media?videoId=<任意ID>`，应返回 404 或「视频不存在」，**不能是 500**。500 说明绑定没生效。

---

## 三、Pages 环境变量（控制端运行时）

在 Cloudflare Pages 项目 → Settings → Environment variables 配置。**带 SECRET 标记的必须选 "Encrypt"**。

| 变量 | 必填 | 说明 |
|---|---|---|
| `SUPABASE_URL` | 是 | 项目地址 |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | **SECRET**。绕过 RLS，仅服务端 |
| `PLAYBACK_TICKET_SECRET` | 是 | **SECRET**。播放票据 HMAC 密钥，随机 32+ 字节 |
| `INTAKE_HANDSHAKE_SECRET` | 是 | **SECRET**。与本机接收服务共享 |
| `INTAKE_PUBLIC_URL` | 是 | 运营者浏览器访问接收服务的地址 |
| `MEDIA_PROFILE` | 否 | 默认 `balanced-540-v1` |

`PROCESSING_BUCKET` 不在这里 —— 它是 R2 **绑定**，由 `wrangler.toml` 提供，不是变量。

---

## 四、构建时环境变量（这一步最容易漏）

这一步和第 3 步**是两回事**。第 3 步是运行时的，这一步是**构建时**的，`tools/build.mjs` 用它重写 `dist/env.js`。设在 Pages 面板里对这一步**无效**。

必须在执行 `npm run build` 的环境（本机 shell 或 CI）里导出这六个：

| 变量 | 写进 env.js 的键 | 值 |
|---|---|---|
| `EASTUDY_API_BASE` | `apiBaseUrl` | **留空**（同源部署，Pages 自己服务 `/api/*`） |
| `EASTUDY_INTAKE_URL` | `intakeUrl` | `http://127.0.0.1:8790/v3` |
| `EASTUDY_SUPABASE_URL` | `supabaseUrl` | 同 `SUPABASE_URL` |
| `EASTUDY_SUPABASE_ANON_KEY` | `supabasePublishableKey` | anon / publishable key |
| `EASTUDY_DEPLOYMENT` | `deployment` | 环境标签，如 `production` |
| `EASTUDY_VERSION` | `version` | 如 `3.0.0` |

细节和注意事项见根目录 `.env.example` 末尾的「Build-time」章节。

**构建会自动中止的两种情况**（这是好事，不是 bug）：

- `EASTUDY_SUPABASE_ANON_KEY` 看起来是 service_role 密钥（以 `eyJ` 开头且超过 200 字符）；
- `env.js` 里找不到要写的键（键名被改过）。

---

## 五、构建与部署

**必须在项目根目录执行。** Pages 从 `<当前工作目录>/functions` 读边缘函数，`dist/` 里**没有**它们的副本 —— 在别处运行 `wrangler pages deploy` 只会得到静态外壳，所有 `/api/*` 404。

```bash
npm install
npm run check        # 契约测试 + 单元测试 + 构建
npm run pages:deploy # = build + wrangler pages deploy dist
```

`npm run check` 的期望输出：`tests 77 / pass 77 / fail 0`，然后构建产出 10 个文件、`env.js 已写入(<你的标签>)`。

---

## 六、部署后验证（四步，别跳）

```bash
# 1. 前端配置写对了没 —— 看 deployment 和 supabaseUrl 是不是目标环境，且不含任何服务端密钥
curl -s https://<你的域名>/env.js

# 2. 边缘函数活着没（不该是 404）
curl -s -o /dev/null -w "%{http_code}\n" https://<你的域名>/api/progress

# 3. 安全头在不在
curl -sI https://<你的域名>/ | grep -i content-security-policy
```

4. 浏览器打开学员端，**按 F12 看 Console**：不应有任何 CSP 报错。然后打开控制端 `/admin/`，登录，确认仪表盘有数据。

---

## 七、媒体 Worker（Python，独立进程）

这套东西**不随 Pages 一起部署**。它是个需要长驻运行的 Python 进程，负责转码、ASR、AI 翻译。

不启动它的后果：视频能上传进库，但永远停在「待处理」，没有转码产物、没有字幕，学员端播不了。

部署方式见 `services/worker/README.md`。它的环境变量取自 `.env.example` 里除 `EASTUDY_*` 之外的部分（`WORKER_*`、`R2_*`、`DEEPSEEK_*`、`WHISPER_*` 等）。

**注意**：AI 相关的密钥有两处来源，优先级是「控制端设置页 > 环境变量」—— 设置页写在 `settings` 表的 `ai` 键里，worker **先读那个**。

---

## 八、安全边界（这几条是设计约束，改动前先理解原因）

- **`public/env.js` 只能放 anon/publishable key。** 它发给每一位访客。service_role key 一旦进来就是凭据泄露 —— 构建脚本和 `assertSafeEnvironment()` 都会拒绝，单元测试也会拦。
- **数据由 RLS 保护。** anon key 公开是设计如此。边缘接口用 service role 绕过 RLS，靠 WHERE 里的 `user_id=eq.` 做归属校验。
- **本机接收服务仅限回环**（`http://127.0.0.1:8790/v3`），不要暴露到公网。
- **第三方脚本一律自托管**（`public/assets/vendor/`），不走 CDN。
- **CSP 里 `script-src` 没有 `'unsafe-inline'`。** 两个 HTML 外壳各有一个行内主题预绘脚本，靠 `public/_headers` 里的 SHA-256 hash 放行。**改动任一行内脚本，就必须重算它的 hash 写回 `_headers`**，否则那个外壳静默失去预绘（表现为开页闪一下错误主题）。`_headers` 里有重算命令。

---

## 九、已知未完成项（交出去时如实说明）

- `profiles.membership_expires_at` 被读取但无写入方，恒为 NULL。会员判定实际走 `vip_expires_at`。
- `videos.video_url` 只在列表查询里出现，无写入方，留给历史数据导入。
- 三个迁移在此前**从未实际执行过**（开发机无 `psql` / `docker`），SQL 已人工审阅但未经运行验证。第 1 步执行时请留意报错。
- AI 管线从未连过真实 DeepSeek 端点，首次接通可能需要调参。
