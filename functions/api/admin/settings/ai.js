/* GET/PUT /api/admin/settings/ai — AI 配置 (M10).

   Which model service the pipeline calls for teaching-material generation, and
   whether that step is switched on at all.

   The single most important thing this file does is *not* return the API key.
   The form says so to the operator's face ("密钥保存在服务端,不会下发到浏览器"),
   and that promise is kept here: the key is written on PUT and read only by the
   worker, which runs with the service role. Returning it — even masked, even to
   an admin — would put a credential in the browser's network log, the app's
   memory, and any screenshot of the settings page.

   So a GET reports `key_present` and the last four characters. That is enough
   for the operator to confirm the key they pasted is the one in use, and not
   enough for the value to leave the server. */

import { HttpError, errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';
import { pick, trimmed } from '../../../_lib/fields.js';
import { assertUpstreamUrl } from '../../../_lib/upstream-url.js';

const CONFIG_KEY = 'ai';

/* 出厂地址。填死一个默认值而不是留空, 是因为"空"在这里不是中性的 ——
   留空的话第一次点保存会报"请填写地址", 而运维多半只是想把 key 换掉。
   默认值是 DeepSeek 官方地址, 但**任何 OpenAI 兼容的服务都能填**, 见
   functions/api/admin/settings/ai-probe.js 的文件头。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

const DEFAULTS = {
  provider: 'DeepSeek',
  base_url: DEFAULT_BASE_URL,
  model: '',
  enabled: false,
  // Sentinels so the UI never shows a broken checkbox. `api_key` is never sent.
  key_present: false,
  key_hint: null,
};

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const client = createClient(env);

    const rows = await client.select('settings', `select=value&key=eq.${CONFIG_KEY}&limit=1`).catch(() => []);
    const stored = parse(rows?.[0]?.value);

    return json({
      config: {
        provider: stored.provider || DEFAULTS.provider,
        /* 地址可以原样下发 —— 它不是一个秘密, 而且运维要看见自己填的是哪个
           环境。但**存进去之前经过了校验**, 所以这里读出来的一定是合法值;
           库里如果有一行手改过的坏数据, 退回默认值而不是把它放出去。 */
        base_url: safeBaseUrl(stored.base_url),
        model: stored.model || DEFAULTS.model,
        enabled: Boolean(stored.enabled),
        key_present: Boolean(trimmed(stored.api_key, 400)),
        // Last four only. A prefix identifies the vendor and a middle reveals
        // length; four trailing characters are enough to tell two keys apart
        // when an operator is checking which one they rotated in.
        key_hint: trimmed(stored.api_key, 400) ? `****${String(stored.api_key).slice(-4)}` : null,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPut({ request, env }) {
  try {
    await requireAdmin(env, request);
    const body = await request.json().catch(() => ({}));
    const client = createClient(env);
    const now = new Date().toISOString();

    const rows = await client.select('settings', `select=value&key=eq.${CONFIG_KEY}&limit=1`).catch(() => []);
    const stored = parse(rows?.[0]?.value);

    const provider = trimmed(pick(body, 'provider'), 60) ?? stored.provider ?? DEFAULTS.provider;
    const model = trimmed(pick(body, 'model'), 80) ?? stored.model ?? DEFAULTS.model;

    /* 地址在这里校验, 不是在前端 —— 前端能拦住的只是"打字打错了", 而这里
       拦住的是"让服务端去请求一个内网地址"。校验逻辑见 _lib/upstream-url.js。
       不填就沿用已存的(或默认), 因为换 key 的时候不该被迫重填地址。 */
    const incomingBase = trimmed(pick(body, 'base_url'), 300);
    const baseUrl = incomingBase
      ? assertUpstreamUrl(incomingBase)
      : (stored.base_url ? assertUpstreamUrl(stored.base_url) : DEFAULT_BASE_URL);

    const enabledRaw = pick(body, 'enabled');
    const enabled = typeof enabledRaw === 'boolean'
      ? enabledRaw
      : (enabledRaw === undefined ? Boolean(stored.enabled) : String(enabledRaw) === 'on');

    // The key is only touched when the request actually carries one. An empty
    // string or an omitted field keeps whatever is stored — which matters,
    // because the form cannot show the current key back, so every save sends
    // an empty box and a naive write would erase the credential on each edit.
    const incoming = trimmed(pick(body, 'api_key'), 400);
    const apiKey = incoming ?? stored.api_key ?? null;
    const clear = pick(body, 'clear_api_key') === true;
    const finalKey = clear ? null : apiKey;

    // Switching the feature on without a key would produce a pipeline that
    // fails at the first generation step, minutes into an upload, with an
    // authentication error the operator has no reason to connect to this
    // checkbox. Refused here, where the cause is still visible.
    if (enabled && !finalKey) {
      throw new HttpError(400, 'AI_KEY_REQUIRED', '开启教学内容生成前请先填写密钥');
    }

    const next = { provider, base_url: baseUrl, model, enabled, api_key: finalKey };
    await client.upsert('settings', [{
      key: CONFIG_KEY,
      value: JSON.stringify(next),
      updated_at: now,
    }], { onConflict: 'key' });

    return json({
      config: {
        provider,
        base_url: baseUrl,
        model,
        enabled,
        key_present: Boolean(finalKey),
        key_hint: finalKey ? `****${String(finalKey).slice(-4)}` : null,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The value column is text; this config is the one setting stored as a JSON
    blob rather than a scalar, because its fields are one unit — a model name
    without its provider is meaningless. A malformed row falls back to empty
    rather than throwing: a corrupted setting should leave the form usable so
    the operator can retype it. */
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

/** 读路径上的地址兜底。库里那一行理论上一定是校验过的, 但它是可以直接改的
    (有人在 SQL 编辑器里手改、或早于本次改动写入的旧行)。读的时候再走一遍
   校验, 通不过就退回默认 —— 一个无法通过的地址放出去, 只会让运维在表单上
   看到一个说不出所以然的红字, 而他并没有改过任何东西。 */
function safeBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return DEFAULT_BASE_URL;
  try {
    return assertUpstreamUrl(raw);
  } catch {
    return DEFAULT_BASE_URL;
  }
}
