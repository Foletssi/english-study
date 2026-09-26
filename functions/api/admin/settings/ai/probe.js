/* POST /api/admin/settings/ai/probe — 第三方通道检测 / 模型获取 (M10)。

   这个接口存在的唯一理由: **密钥不能进浏览器**。
   要检测"这个地址 + 这个 key 到底通不通", 只有服务端能做 —— 浏览器直接 fetch
   第三方的话, key 就得下发到前端。所以检测和取模型都在这儿代理。

   三种模式, 对应控制端上的三个动作:

     models  取模型列表。运维填了地址和 key 之后, 最想知道的是"这个地址到底
             提供哪些模型" —— 让他自己去翻文档然后手打模型名, 打错了要到第一
             次生成时才报错, 那时候已经过了几分钟的上传。所以这里先把列表拉
             回来, 表单上做成可选项。
     test    真正发一次最小补全。这是**唯一**能证明通道可用的检查: /models
             在很多网关上是可以匿名或者用错 key 访问的, 所以"模型能列出来"不
             等于"能生成"。发一个 max_tokens 极小的请求, 只验证鉴权和路由。
     key     只做鉴权确认, 不消耗生成配额。部分服务商对 /models 也校验 key,
             这一档留给"我只想确认密钥填对了"的场景。

   ---------------------------------------------------------------------------
   一律不把上游的响应体原样透出去

   上游出错时返回的 JSON 里常常带着请求头回显、内部主机名、甚至部分密钥。
   这里只取 message / error.message / error.code 三个字段, 并且截断 —— 中间
   任何一个字段都可能被塞进一个超长字符串。运维需要的是"401 鉴权失败",
   不是一整个上游堆栈。 */

import { HttpError, errorResponse, json } from '../../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../../_lib/supabase.js';
import { pick, trimmed } from '../../../../_lib/fields.js';
import { assertUpstreamUrl, joinUrl } from '../../../../_lib/upstream-url.js';

const CONFIG_KEY = 'ai';

/* 上游超时。取模型列表按说很快, 但国内访问部分海外网关会慢 —— 12 秒是
   "比人耐心的上限短一点"的值。超时后必须给出明确文案, 不能让它挂在那里
   让运维以为按钮坏了。 */
const TIMEOUT_MS = 12_000;

/* 检测用的一次补全最多花几个 token。1 就够 —— 我们要的是 200 或者 401,
   不是内容。设 1 而不是 0: 部分网关把 max_tokens:0 当作非法参数返回 400,
   那样会把"参数错了"误报成"通道不通"。 */
const PROBE_MAX_TOKENS = 1;

export async function onRequestPost({ request, env }) {
  try {
    await requireAdmin(env, request);

    const body = await request.json().catch(() => ({}));
    const mode = trimmed(pick(body, 'mode'), 20) || 'test';
    if (!['models', 'test', 'key'].includes(mode)) {
      throw new HttpError(400, 'AI_PROBE_MODE', '未知的检测类型');
    }

    const client = createClient(env);
    const rows = await client.select('settings', `select=value&key=eq.${CONFIG_KEY}&limit=1`).catch(() => []);
    const stored = parse(rows?.[0]?.value);

    /* 表单允许"先测再存": 运维填完地址和 key 通常想立刻点一下检测, 而不是
       先保存再回来测。所以请求里带的 base_url / api_key 优先于库里的值。
       这不会成为一条绕过保存的写路径 —— 这里只读, 不写任何东西。 */
    const baseUrl = assertUpstreamUrl(
      trimmed(pick(body, 'base_url'), 300) ?? stored.base_url ?? '',
    );
    const apiKey = trimmed(pick(body, 'api_key'), 400) ?? trimmed(stored.api_key, 400) ?? null;
    if (!apiKey) {
      throw new HttpError(400, 'AI_KEY_REQUIRED', '请先填写密钥');
    }

    const started = Date.now();

    if (mode === 'models') {
      const payload = await callUpstream({ baseUrl, apiKey, path: '/models', method: 'GET' });
      return json({
        ok: true,
        mode,
        latency_ms: Date.now() - started,
        models: normalizeModels(payload),
        message: '连接正常',
      });
    }

    if (mode === 'key') {
      /* 有 /models 就借它验鉴权; 网关不支持时(404/405)退回一次补全,
         所以这一档在两种服务商上都能得出一个结论。 */
      try {
        await callUpstream({ baseUrl, apiKey, path: '/models', method: 'GET' });
      } catch (error) {
        if (!(error instanceof HttpError) || !(error.status === 404 || error.status === 405)) throw error;
        await probeCompletion({ baseUrl, apiKey, model: resolveModel(body, stored) });
      }
      return json({ ok: true, mode, latency_ms: Date.now() - started, message: '密钥有效' });
    }

    const model = resolveModel(body, stored);
    const result = await probeCompletion({ baseUrl, apiKey, model });
    return json({
      ok: true,
      mode: 'test',
      latency_ms: Date.now() - started,
      model,
      // 上游确实回了话才算通。这里连 model 回显都带上: 有些网关会静默把
      // 不认识的模型名替换成默认模型, 运维能从回显里看出来。
      upstream_model: result.model,
      message: '通道正常,已收到模型响应',
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// --------------------------------------------------------------- 上游调用

/** 一次最小补全。返回 { model } —— 内容本身不关心, 只关心"它答了"。 */
async function probeCompletion({ baseUrl, apiKey, model }) {
  const payload = await callUpstream({
    baseUrl,
    apiKey,
    path: '/chat/completions',
    method: 'POST',
    body: {
      model,
      max_tokens: PROBE_MAX_TOKENS,
      temperature: 0,
      messages: [{ role: 'user', content: 'ping' }],
    },
  });
  return { model: payload?.model ?? null };
}

/* 一次上游请求的全部处理: 超时、鉴权头、错误翻译。
   用 OpenAI 兼容协议而不是 DeepSeek 专有协议 —— DeepSeek、Moonshot、通义、
   SiliconFlow、以及本地 vLLM/Ollama 都提供 /chat/completions 和 /models,
   换成任何一家都不用改这里的代码。 */
async function callUpstream({ baseUrl, apiKey, path, method, body = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(joinUrl(baseUrl, path), {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      // 上游可能是我们完全不认识的网关, 不让它重定向: 301 之后 fetch 会把
      // Authorization 头丢掉, 于是"鉴权失败"看起来像"地址写错了"。
      redirect: 'manual',
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new HttpError(504, 'AI_UPSTREAM_TIMEOUT', `连接超时(${TIMEOUT_MS / 1000} 秒未响应),请检查地址是否可达`);
    }
    /* fetch 在这里失败基本只有两种原因: 域名解析不了, 或者 TLS 握手失败。
       把原文附在后面 —— 运维需要知道是 DNS 还是证书, 这两件事的修法不一样。 */
    throw new HttpError(502, 'AI_UPSTREAM_UNREACHABLE',
      `无法连接到该地址:${String(error?.message || error).slice(0, 160)}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    /* manual 模式下重定向会原样返回。多半是地址少了或多了 /v1 导致的。 */
    throw new HttpError(502, 'AI_UPSTREAM_REDIRECT',
      `该地址返回了重定向(${response.status}),请检查 API 地址是否完整(常见写法以 /v1 结尾)`);
  }

  const text = await response.text().catch(() => '');
  const payload = safeJson(text);

  if (!response.ok) {
    throw new HttpError(httpStatusFor(response.status), codeFor(response.status),
      describeUpstream(response.status, payload));
  }

  return payload;
}

/** 把上游的 JSON 摘成一句能看懂的话。见文件头: 绝不透传整个响应体。 */
function describeUpstream(status, payload) {
  const detail = String(
    payload?.error?.message
    ?? payload?.message
    ?? payload?.error?.code
    ?? '',
  ).slice(0, 200);

  if (status === 401 || status === 403) {
    return detail ? `鉴权失败:${detail}` : '鉴权失败,请检查密钥是否正确、是否已过期';
  }
  if (status === 404) {
    return detail ? `地址不存在:${detail}` : '该地址没有这个接口,请检查 API 地址是否完整(常见写法以 /v1 结尾)';
  }
  if (status === 429) {
    return detail ? `触发限流:${detail}` : '该密钥触发了服务商限流,请稍后再试或检查额度';
  }
  if (status === 402 || status === 400) {
    return detail ? `请求被拒绝:${detail}` : `请求被拒绝(HTTP ${status}),请检查模型名称是否有效`;
  }
  return detail ? `上游返回 ${status}:${detail}` : `上游返回 HTTP ${status}`;
}

function httpStatusFor(upstreamStatus) {
  // 401/403 是"你填的 key 不对", 属于调用方可修的错误, 原样带出去。
  if (upstreamStatus === 401 || upstreamStatus === 403) return 401;
  // 其余一律归到 502: 问题在上游, 不在我们的服务, 但调用方需要看到具体文案。
  return 502;
}

function codeFor(upstreamStatus) {
  if (upstreamStatus === 401 || upstreamStatus === 403) return 'AI_UPSTREAM_AUTH';
  if (upstreamStatus === 429) return 'AI_UPSTREAM_RATE_LIMIT';
  return 'AI_UPSTREAM_ERROR';
}

/** /models 的返回结构各家略有出入, 统一成 [{id, label}]。 */
function normalizeModels(payload) {
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const seen = new Set();
  const models = [];
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : (entry?.id ?? entry?.name ?? entry?.model);
    const value = String(id ?? '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    models.push({ id: value, label: value });
  }
  // 有些服务商的 /models 会把 embedding/rerank 模型一起列出来, 它们不能用于
  // 对话补全。不在这里过滤 —— 过滤规则各家不同, 误删比多列更糟; 让运维自己
  // 选, 选错了由 test 那一档报出来。
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function resolveModel(body, stored) {
  const model = trimmed(pick(body, 'model'), 80) ?? stored.model ?? '';
  if (!model) {
    throw new HttpError(400, 'AI_MODEL_REQUIRED',
      '请先填写模型名称。如果不知道填什么,先点"获取模型"从列表里选一个。');
  }
  return model;
}

function safeJson(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 与 settings/ai.js 里同名函数一致 —— 一行坏数据不该让整个配置读不出来。 */
function parse(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
