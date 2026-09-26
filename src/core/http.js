/* Eastudy V3 — HTTP with one error shape.

   The legacy edge functions returned `{error: 'CODE'}` and three separate
   client dictionaries translated codes to Chinese, so an unlisted code
   surfaced to the user as a raw constant. V3 funnels every failure through
   ApiError, and each service module owns exactly one message map. */

export class ApiError extends Error {
  constructor(code, { message, status = 0, detail = null, cause = null } = {}) {
    super(message || code || '请求失败');
    this.name = 'ApiError';
    this.code = code || 'UNKNOWN';
    this.status = status;
    this.detail = detail;
    this.cause = cause;
  }

  /** Retrying is worth it for throttling, server faults and network loss —
      never for a 4xx that describes a permanent problem. */
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0 || this.code === 'NETWORK';
  }
}

export const DEFAULT_TIMEOUT = 30_000;

/** Build the querystring for `query`. Absent, null and empty-string values are
    omitted rather than sent as empty parameters: an unset filter and a filter
    explicitly set to nothing mean the same thing to every handler here, and
    `?q=` reads as "search for the empty string" in a URL you paste into a log.
    `false` is kept, because a boolean filter set to false is a real choice. */
function withQuery(url, query) {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}

export async function request(url, {
  method = 'GET',
  body = undefined,
  headers = {},
  timeout = DEFAULT_TIMEOUT,
  signal = null,
  parse = 'auto',
  query = null,
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeout ? setTimeout(() => { timedOut = true; controller.abort(); }, timeout) : null;
  const forward = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw new ApiError('ABORTED', { message: '请求已取消' });
    signal.addEventListener('abort', forward, { once: true });
  }

  const finalHeaders = { Accept: 'application/json', ...headers };
  const isBinary = body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  let payload = body;
  if (body != null && typeof body === 'object' && !isBinary && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
    finalHeaders['Content-Type'] ??= 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(withQuery(url, query), { method, body: payload, headers: finalHeaders, signal: controller.signal, credentials: 'omit' });
  } catch (error) {
    if (timedOut) throw new ApiError('TIMEOUT', { message: '请求超时，请检查网络后重试。', cause: error });
    if (signal?.aborted) throw new ApiError('ABORTED', { message: '请求已取消', cause: error });
    throw new ApiError('NETWORK', { message: '网络连接失败，请检查网络后重试。', cause: error });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }

  if (parse === 'none') return response;

  const wantsJson = parse === 'json'
    || (parse === 'auto' && (response.headers.get('content-type') || '').includes('application/json'));
  const data = wantsJson ? await response.json().catch(() => null) : await response.text();

  if (!response.ok) {
    const code = (data && typeof data === 'object' && (data.error || data.code)) || `HTTP_${response.status}`;
    const message = (data && typeof data === 'object' && (data.message || data.error_description)) || undefined;
    throw new ApiError(code, { message, status: response.status, detail: data });
  }
  return data;
}

export function get(url, options) {
  return request(url, { ...options, method: 'GET' });
}

export function post(url, body, options) {
  return request(url, { ...options, method: 'POST', body });
}

export function put(url, body, options) {
  return request(url, { ...options, method: 'PUT', body });
}

export function del(url, options) {
  return request(url, { ...options, method: 'DELETE' });
}

export function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ApiError('ABORTED', { message: '已取消' })); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(new ApiError('ABORTED', { message: '已取消' }));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Exponential backoff with jitter. `onRetry` fires before each wait so the UI
    can say "正在重试" instead of freezing. */
export async function withRetry(fn, {
  attempts = 4,
  baseMs = 400,
  maxMs = 8000,
  signal = null,
  shouldRetry = null,
  onRetry = null,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = shouldRetry ? shouldRetry(error, attempt) : (error instanceof ApiError ? error.retryable : false);
      if (!retryable || attempt === attempts - 1 || signal?.aborted) break;
      const wait = Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + Math.random() * 0.5);
      onRetry?.(error, attempt, wait);
      await sleep(wait, signal);
    }
  }
  throw lastError;
}
