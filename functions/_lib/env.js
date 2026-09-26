/* Eastudy V3 — edge environment access.

   Every function reads its configuration through here so a missing binding
   fails loudly at the top of a request with a named variable, instead of
   surfacing as `undefined` deep inside a handler. */

export function required(env, name) {
  const value = env[name];
  if (value === undefined || value === null || value === '') {
    throw new HttpError(500, 'CONFIG_MISSING', `缺少环境变量 ${name}`);
  }
  return value;
}

export function optional(env, name, fallback = null) {
  const value = env[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

export function supabaseConfig(env) {
  return {
    url: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    serviceKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: optional(env, 'SUPABASE_ANON_KEY'),
  };
}

export class HttpError extends Error {
  constructor(status, code, message, detail = null) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function errorResponse(error) {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message, detail: error.detail }, { status: error.status });
  }
  console.error('[edge] 未处理异常', error);
  return json({ error: 'INTERNAL', message: '服务器内部错误' }, { status: 500 });
}
