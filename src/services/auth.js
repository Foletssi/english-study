/* Eastudy V3 — authentication and role.
   Wraps Supabase Auth. Role comes from the profile record, never from the
   client's own claim: the admin surface re-checks it server-side on every
   admin API call, and this copy only decides what to render. */

import { apiUrl, assertSafeEnvironment, readEnvironment } from '../config/environment.js';
import { ApiError, get } from '../core/http.js';
import { emit, EVENTS } from '../core/bus.js';

const MESSAGES = {
  'Invalid login credentials': '手机号或密码不正确。',
  'Email not confirmed': '账号尚未激活，请联系管理员。',
  'Too many requests': '尝试过于频繁，请稍后再试。',
  'User not found': '该账号不存在。',
  over_request_rate_limit: '尝试过于频繁，请稍后再试。',
};

export function createAuthService() {
  const env = assertSafeEnvironment();
  const client = globalThis.supabase.createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'eastudy.v3.auth',
    },
  });

  let profile = null;
  let session = null;

  function describe(error) {
    const raw = error?.message || error?.error_description || '登录失败。';
    return new ApiError(error?.code || 'AUTH_FAILED', { message: MESSAGES[raw] || raw });
  }

  async function loadProfile(userId) {
    const result = await client.from('profiles').select('id, role, display_name, phone, membership_expires_at').eq('id', userId).maybeSingle();
    if (result.error) throw new ApiError('PROFILE_LOAD_FAILED', { message: '无法读取账号资料。' });
    return result.data;
  }

  async function applySession(next) {
    session = next;
    profile = next?.user ? await loadProfile(next.user.id).catch(() => null) : null;
    emit(EVENTS.AUTH_CHANGED, { session, profile });
  }

  const service = {
    client,
    get session() { return session; },
    get user() { return session?.user ?? null; },
    get profile() { return profile; },
    get isAdmin() { return profile?.role === 'admin'; },
    get isSignedIn() { return Boolean(session?.user); },

    async init() {
      const { data } = await client.auth.getSession();
      await applySession(data?.session ?? null);
      client.auth.onAuthStateChange((event, next) => {
        // Async work inside the callback deadlocks the Supabase client, so defer.
        setTimeout(() => { applySession(next).catch(() => {}); }, 0);
      });
      return session;
    },

    async signInWithPassword(phone, password) {
      const email = normalizePhone(phone);
      if (!email) throw new ApiError('PHONE_INVALID', { message: '请输入 11 位手机号。' });
      if (!password) throw new ApiError('PASSWORD_REQUIRED', { message: '请输入密码。' });
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw describe(error);
      await applySession(data.session);
      return data.session;
    },

    async signOut() {
      await client.auth.signOut();
      await applySession(null);
    },

    async requireAdmin() {
      if (!service.isAdmin) {
        throw new ApiError('ADMIN_REQUIRED', { message: '需要管理员权限。' });
      }
      // Server-side confirmation: the client copy is a rendering hint only.
      const check = await get(apiUrl('/api/admin/session')).catch(() => null);
      if (!check?.admin) throw new ApiError('ADMIN_REQUIRED', { message: '管理员会话已失效，请重新登录。' });
      return true;
    },

    async accessToken() {
      const { data } = await client.auth.getSession();
      return data?.session?.access_token ?? null;
    },
  };

  return service;
}

/** The product signs in by phone; Supabase Auth wants an email. The mapping is
    fixed and used by the learner-auth edge function on the other side. */
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `${digits}@phone.eastudy.local`;
  if (digits.length > 11) return null;
  return null;
}

export function environmentSummary() {
  const env = readEnvironment();
  return { environment: env.environment, hasSupabase: Boolean(env.supabaseUrl) };
}
