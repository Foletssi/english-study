/* Eastudy V3 — Supabase REST access from the edge.

   A tiny fetch wrapper rather than an SDK import: the edge runtime already has
   fetch, and the queries this app makes are few and explicit. It keeps the
   deployed bundle small and makes every database call greppable. */

import { HttpError, supabaseConfig } from './env.js';

export function createClient(env) {
  const { url, serviceKey, anonKey } = supabaseConfig(env);

  async function call(path, { method = 'GET', body, key = serviceKey, headers = {}, prefer } = {}) {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (!response.ok) {
      throw new HttpError(response.status, payload?.code || `SUPABASE_${response.status}`, payload?.message || '数据库请求失败', payload);
    }
    return payload;
  }

  return {
    url,
    anonKey,
    call,
    select(table, query = 'select=*', options = {}) {
      return call(`${table}?${query}`, options);
    },
    insert(table, rows, options = {}) {
      return call(table, { method: 'POST', body: rows, prefer: 'return=representation', ...options });
    },
    update(table, query, patch, options = {}) {
      return call(`${table}?${query}`, { method: 'PATCH', body: patch, prefer: 'return=representation', ...options });
    },
    remove(table, query, options = {}) {
      return call(`${table}?${query}`, { method: 'DELETE', ...options });
    },
    upsert(table, rows, { onConflict } = {}) {
      return call(table, {
        method: 'POST',
        body: rows,
        prefer: `resolution=merge-duplicates,return=representation${onConflict ? `,on_conflict=${onConflict}` : ''}`,
      });
    },
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** Verify a Supabase access token and return the user it belongs to.
    Uses the auth endpoint rather than decoding the JWT locally: a rotated or
    revoked session must be rejected, and only the auth server knows that. */
export async function requireUser(env, request) {
  const header = request.headers.get('Authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录');

  const { url, serviceKey } = supabaseConfig(env);
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new HttpError(401, 'UNAUTHENTICATED', '登录状态已失效,请重新登录');

  const user = await response.json();
  if (!user?.id) throw new HttpError(401, 'UNAUTHENTICATED', '登录状态已失效,请重新登录');

  return { token, user };
}

/** Admin gate. The role is read from the database on every call: a client
    that lies about its role gets nowhere, because nothing here trusts the
    client's copy of it. */
export async function requireAdmin(env, request) {
  const { user, token } = await requireUser(env, request);
  const client = createClient(env);
  const rows = await client.select('profiles', `select=id,role&id=eq.${encodeURIComponent(user.id)}&limit=1`);
  const role = rows?.[0]?.role;
  if (role !== 'admin') throw new HttpError(403, 'ADMIN_REQUIRED', '需要管理员权限');
  return { user, token, role };
}
