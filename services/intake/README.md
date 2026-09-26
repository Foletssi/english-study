# Eastudy V3 — 本机接收服务(intake)

替代旧版的 8788/8789 两个上传服务。这是一个只在本机运行的小型 HTTP 服务,
负责把管理端选中的原片以分片方式落盘、校验、然后交给处理流水线。

## 为什么重写

旧版把接收、校验、队列、静态文件服务混在一个 18KB 的模块里,分片大小在握手时
一次性确定且不可变,断点信息只记在服务端 SQLite 而客户端只有 localStorage 里
一条"这个文件传过"的记录。重传时必须整文件重新哈希才能对齐偏移量。

V3 的目标是:任何时刻断电、断网、关浏览器、关服务,重新打开都能从正确的位置
继续,并且不需要重读已经传完的字节。

## 启动

```bash
python -m services.intake.server --port 8790 --data ./runtime/intake
```

首次启动会在数据目录生成一个 `token` 文件,管理端页面通过
`worker-local-challenge` 握手拿到一次性票据,后续请求用 `Bearer` 头携带。

## 协议

所有路径前缀 `/v3`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v3/capability` | 本机是否就绪、磁盘余量、workerId、challenge |
| `POST` | `/v3/sessions` | 新建或重连一个接收会话 |
| `GET` | `/v3/sessions/:id` | 会话状态与已收分片列表 |
| `PUT` | `/v3/sessions/:id/chunks/:index` | 上传一个分片,需 `X-Chunk-SHA256` |
| `PUT` | `/v3/sessions/:id/cover` | 上传封面 |
| `POST` | `/v3/sessions/:id/complete` | 提交并触发组装校验 |
| `DELETE` | `/v3/sessions/:id` | 放弃会话 |

### 分片大小协商

客户端按文件大小规划(8/16/32/48 MiB),在 `POST /v3/sessions` 里作为
`chunkSizeHint` 提出。服务端只有在以下情况才收紧:

- 剩余磁盘不足以容纳一个分片再加 20% 余量
- 内存受限模式(`--low-memory`)下上限压到 16 MiB
- 该 session 之前因 `CHUNK_TOO_LARGE` 失败过,此时减半

服务端**不会**放大客户端提出的值。返回的 `chunkBytes` 是权威值,客户端据此
重新规划分片;如果返回值和客户端已上传的分片边界冲突,服务端会返回
`CHUNK_RANGE_INVALID`,客户端重新对齐并从第一个未确认的分片继续。

### 恢复语义

`POST /v3/sessions` 带 `resume: true` 时:

1. 服务端用 `source.sha256 + size` 查找已有会话目录
2. 命中则返回该会话的 `uploadId` 和 `received[]`(每项 `{idx, sha, bytes}`)
3. 未命中则新建,但**保留同目录下已有的分片文件**(按内容寻址,文件名是分片
   哈希的前 16 位,所以偏移量变化不会让已有数据失效)

第 3 点是关键:客户端重新规划分片大小后,已传的分片仍然可用,服务端在
`complete` 阶段按内容重新拼装,而不是按固定偏移量。

### 组装与校验

`complete` 之后服务端进入 `VERIFYING`:

1. 按索引顺序读取所有分片文件
2. 边读边算整文件 SHA-256,同时写入目标原片
3. 与 `source.sha256` 比对;不一致返回 `SOURCE_SHA_MISMATCH`,**不删除分片**
4. 一致则登记 `READY`,返回 `{state:'READY', job:{...}}`

组装是流式的,不把整个文件读进内存。2GB 文件峰值内存约 32MiB。

## 磁盘与并发上限

- 单个会话最多 2GB
- 同时活跃会话最多 2 个(`INTAKE_QUEUE_FULL`)
- 剩余磁盘低于 5GB 时拒绝新会话(`INTAKE_DISK_LOW`)
- 空闲超过 24 小时的未完成会话在下次启动时清理,已完成的不动

## 不做的事

- 不接收原片到云端。原片只落本机磁盘,这是旧版的既定架构,保持。
- 不解析视频、不做转码。那是 `services/worker` 的职责。
- 不持久化任何凭据。票据只在内存里,重启即失效,管理端会重新握手。
