/* Eastudy V3 — the one place that knows how to talk to our own edge API.

   Every service goes through here so that the bearer token, the JSON envelope,
   the retry policy and the error shape are decided once. The legacy had each
   page call fetch() directly, which is how it ended up with four different
   ways of reading an error message. */

import { ApiError, request } from '../core/http.js';
import { apiUrl } from '../config/environment.js';

export function createApi({ getToken }) {
  async function call(path, { method = 'GET', body, query, signal, timeoutMs, retry, parse } = {}) {
    const token = typeof getToken === 'function' ? await getToken() : getToken;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    return request(apiUrl(path), {
      method,
      body,
      signal,
      headers,
      // Three translations between the service layer's vocabulary and the
      // transport's, each of which used to be dropped on the floor:
      //   query → a querystring. Passing `query` through unchanged meant every
      //     filtered list (学员搜索、日志筛选、分类筛选) sent no parameters at all
      //     and silently received page 1 of everything.
      //   timeoutMs → `timeout`, the name request() actually reads. A service
      //     asking for 120s got the 30s default.
      //   parse → `parse`, so a route returning a blob can opt out of the JSON
      //     body handling.
      timeout: timeoutMs,
      parse,
      query,
      // Reads are safe to retry; writes are not, unless the caller says the
      // endpoint is idempotent. A retried upload chunk is idempotent by design;
      // a retried "create video" would duplicate the row. Note request() takes
      // no `retry`, so this only informs the retryable errors it surfaces; the
      // actual retrying is the caller's, via withRetry.
      retry: retry ?? (method === 'GET' || method === 'HEAD'),
    });
  }

  return {
    get: (path, options) => call(path, { ...options, method: 'GET' }),
    post: (path, body, options) => call(path, { ...options, method: 'POST', body }),
    put: (path, body, options) => call(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options) => call(path, { ...options, method: 'PATCH', body }),
    delete: (path, options) => call(path, { ...options, method: 'DELETE' }),
    call,
    ApiError,
  };
}

/** Turn any thrown value into something safe to show a learner. */
export function describeError(error) {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK') return '网络连接失败,请检查网络后重试。';
    if (error.status === 401) return '登录状态已过期,请重新登录。';
    if (error.status === 403) return '没有访问权限。';
    if (error.status === 404) return '内容不存在或已被下架。';
    if (error.status === 409) return error.message || '内容已被其他人修改,请刷新后重试。';
    if (error.status === 429) return '操作过于频繁,请稍后再试。';
    if (error.status >= 500) return '服务器暂时不可用,请稍后重试。';
    return error.message || '请求失败。';
  }
  return error?.message || '出现未知错误。';
}
