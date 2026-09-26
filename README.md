# Eastudy V3

英语视频学习站。学生端做逐句字幕、生词本、学习计划与进度;控制端做视频入库、转码调度、字幕编辑、会员与邀请码管理。

**技术栈**:Cloudflare Pages(Functions 做边缘接口)+ Supabase(Postgres + Auth)+ Cloudflare R2(媒体, APAC location hint)。第三方脚本一律自托管,不走 CDN。

---

## 目录结构

```
public/            静态外壳。构建时原样复制到 dist/
  index.html       学生端入口
  admin/           控制端入口(noindex)
  env.js           唯一因部署而变化的文件 —— 见下文
  _routes.json     哪些路径交给 Functions
  _headers         安全响应头(含 CSP)
  assets/          样式、字型,以及 vendor/ 下的 hls.js、supabase.js、sha256.js
src/               前端源码,esbuild 打成两个 bundle
  app/             两个入口:student-main.js、admin-main.js
  admin/ student/  控制端与学生端页面
  services/        接口封装
  config/          environment.js —— 读取 env.js
functions/         边缘接口。Pages 从项目根读取,不打包,也不复制进 dist/
  _lib/            共享库(鉴权、分页、票据签名、播放档位)
  api/             路由
services/intake/   本机接收服务(Python)。仅回环,不部署
supabase/
  migrations/      数据库结构
tests/
  contracts/       路由与调用点的对账测试
  unit/            单元测试
tools/             build.mjs、dev.mjs
docs/              设计与差异记录
```

---

## 本地开发

```bash
npm install
npm run dev
```

`npm run dev` 会构建一次、起 `wrangler pages dev`(默认 :8788),并尝试拉起本机接收服务(:8790)。首次运行前需要 `.dev.vars`(见 `wrangler.toml`,该文件已在 `.gitignore` 中):

```
SUPABASE_URL="https://<project>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="eyJ..."
PLAYBACK_TICKET_SECRET="<随机长串>"
INTAKE_HANDSHAKE_SECRET="<随机长串>"
```

学生端 <http://localhost:8788/>,控制端 <http://localhost:8788/admin/>。

常用命令:

```bash
npm run build            # 构建到 dist/
npm run build -- --minify
npm run test             # 契约测试 + 单元测试
npm run check            # test 之后 build
npm run intake           # 只起接收服务
```

---

## 部署

### 1. 数据库

按文件名顺序执行 `supabase/migrations/` 下的**全部**迁移(或用 `supabase db push`)。三个文件缺一不可,顺序不能颠倒:

| 文件 | 做什么 |
|---|---|
| `0001_init.sql` | 15 张表、索引、唯一约束、RLS 策略、分类与设置默认值 |
| `0002_worker.sql` | 处理流水线:`processing_jobs`、`worker_heartbeats`,以及 `worker_claim_job` / `worker_renew_lease` 等函数 |
| `0003_learned.sql` | `learning_progress.learned_at` 列 —— 学员手动「标记已学」用 |

**漏执行 `0002` 的后果最隐蔽**:worker 抢任务的 `worker_claim_job` 不存在,worker 起来后每次轮询都报错,而页面看起来一切正常,只是永远没有任务被处理。**漏执行 `0003` 的后果是报错**:`/api/progress` 的 SELECT 里带了 `learned_at`,列不存在则整个进度接口 500,学员端首页与学习页都会空。

`0001` 末尾会创建 `on_auth_user_created` 触发器,让每个注册用户在 `profiles` 里有对应行 —— 边缘接口每次鉴权都要读这一行。

### 2. 边缘环境变量

在 Cloudflare Pages 项目设置里配置**加密变量**(每个环境一套):

| 变量 | 说明 |
|---|---|
| `SUPABASE_URL` | 项目地址 |
| `SUPABASE_SERVICE_ROLE_KEY` | **仅服务端**。绕过 RLS |
| `PLAYBACK_TICKET_SECRET` | 播放票据 HMAC 密钥 |
| `INTAKE_HANDSHAKE_SECRET` | 与本机接收服务共享的密钥 |
| `INTAKE_PUBLIC_URL` | 运营者浏览器访问接收服务的地址 |
| `PROCESSING_BUCKET` | R2 绑定(不是变量,见 `wrangler.toml`) |
| `MEDIA_PROFILE` | 可选,默认 `balanced-540-v1` |

### 3. 前端环境变量与构建

浏览器侧的配置全部来自 `public/env.js`,而构建脚本 `tools/build.mjs` 会按下面的环境变量重写它。**只有这一个文件因部署而异**,所以核对部署是否正确,只需 diff 这一个文件。

| 变量 | 写入 `env.js` 的键 |
|---|---|
| `EASTUDY_API_BASE` | `apiBaseUrl`(留空 = 同源) |
| `EASTUDY_INTAKE_URL` | `intakeUrl` |
| `EASTUDY_SUPABASE_URL` | `supabaseUrl` |
| `EASTUDY_SUPABASE_ANON_KEY` | `supabasePublishableKey` |
| `EASTUDY_DEPLOYMENT` | `deployment` |
| `EASTUDY_VERSION` | `version` |

```bash
npm run check
npm run pages:deploy     # = build + wrangler pages deploy dist
```

**必须在项目根目录执行**。Pages 从 `<当前工作目录>/functions` 读边缘函数,`dist/` 里没有它们的副本 —— 在别处运行 `wrangler pages deploy` 只会得到静态外壳,所有 `/api/*` 都会 404。构建期有一道断言兜住另一半:`dist/` 里一旦出现 `functions/`,构建直接失败。

构建会在两种情况下**中止**而非产出包体:anon key 看起来是 service_role key(以 `eyJ` 开头且超过 200 字符),或 `env.js` 里找不到要写的键。两者都是"静默出错、上线后才暴露"的那类问题,所以在构建期拦掉。

### 4. 验证

```bash
curl -s https://<你的域名>/env.js
```

`deployment` 应是目标环境标签,`supabaseUrl` 应是目标项目,且**不含任何服务端密钥**。

---

## 安全边界

这几条是设计约束,改动前请先理解原因:

- **`public/env.js` 只放 anon/publishable key。** 它发给每一位访客。service_role key 一旦进来就是凭据泄露 —— 构建脚本和 `assertSafeEnvironment()` 都会拒绝,单元测试也会拦。
- **数据由 RLS 保护。** anon key 公开是设计如此。迁移里所有表都开了 RLS,只有客户端会直接读的表(如 `profiles`、`learning_progress`)留了策略。边缘接口用 service role,绕过 RLS,靠 WHERE 里的 `user_id=eq.` 做归属校验。
- **接收服务仅限本机。** `http://127.0.0.1:8790/v3`,不要暴露到公网接口。它按内容寻址暂存上传分片,不转码。
- **第三方脚本自托管。** hls.js、supabase-js、sha256 都在 `public/assets/vendor/`,不使用 CDN —— 企业代理屏蔽第三方域名时功能不能断,而且部署的字节必须等于审阅过的字节。

---

## 测试

```bash
npm run test:contracts   # 对账 src/ 里的调用点与 functions/ 的文件路由
npm run test:unit
```

契约测试从文件系统推导路由,从 `src/` 抽取 `/api/...` 字面量,然后分三类报告:

- **断链** —— 调用点没有对应路由。构建不会发现这个,浏览器只会在点击时报 404。
- **仅由 catch-all 兜底** —— 调用方写死了字面量段,却没有同名文件接住。落到 `[[path]]` 的请求会返回一个读起来像服务端故障的 404。
- **待实现** —— 调用点旁标注了 `待实现`。默认不失败,`--strict` 下失败。

---

## 已知待办

- `processing_jobs.stage`、`worker_heartbeats.status` 的取值集合由 `services/worker` 写入。该 worker 的源码**在本仓库内**(`services/worker/`,Python,见 `services/worker/README.md`),但它是一个需要独立长驻运行的进程,不随 Pages 一起部署 —— 迁移里这两列因此**没有** CHECK 约束。
- `profiles.membership_expires_at` 被 `admin/session.js` 与 `src/services/auth.js` 读取,但没有任何代码写入,恒为 NULL。会员判定实际走 `vip_expires_at`。要么给它写入方,要么统一到 `vip_expires_at`。
- `videos.video_url` 只在查询列表里出现,没有写入方。留给历史数据导入;导入结束后应连同列一起删掉。
