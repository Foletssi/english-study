/* Eastudy V3 — runtime environment.
   Values come from /env.js, which the build writes from the deploy target.
   Nothing here is secret: the Supabase publishable key and the local intake
   origin are both designed to be public. */

/* Every key here must also exist in public/env.js, and vice versa — this object
   is the only list of what the client reads, and tests/unit/environment.test.mjs
   asserts the two agree. The legacy had an `environment: 'development'` entry
   that no file ever set: it was always overwritten by the spread below, so it
   read as a real default while being dead. The deployment label is `deployment`,
   and it comes from env.js like everything else. */
const FALLBACK = Object.freeze({
  supabaseUrl: '',
  supabasePublishableKey: '',
  intakeUrl: 'http://127.0.0.1:8790/v3',
  apiBaseUrl: '',
  deployment: 'local',
  version: '3.0.0',
});

let cached = null;

export function readEnvironment() {
  if (cached) return cached;
  const raw = globalThis.__EASTUDY_ENV__ ?? {};
  cached = Object.freeze({
    ...FALLBACK,
    ...raw,
    apiBaseUrl: raw.apiBaseUrl || '',
    intakeUrl: (raw.intakeUrl || FALLBACK.intakeUrl).replace(/\/$/, ''),
  });
  return cached;
}

export function assertSafeEnvironment() {
  const env = readEnvironment();
  const problems = [];
  if (!env.supabaseUrl) problems.push('supabaseUrl 未配置');
  if (!env.supabasePublishableKey) problems.push('supabasePublishableKey 未配置');
  if (env.supabasePublishableKey.startsWith('eyJ') && env.supabasePublishableKey.length > 200) {
    // A service-role JWT in a browser bundle is a credential leak, not a typo.
    problems.push('检测到疑似 service_role 密钥，浏览器端只允许 publishable key');
  }
  if (problems.length) {
    throw new Error(`环境配置有误：${problems.join('；')}`);
  }
  return env;
}

export function apiUrl(path) {
  const env = readEnvironment();
  const base = env.apiBaseUrl || '';
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/* The same values as a live object, for callers that read one field at a time
   rather than destructuring the whole thing: `environment.intakeUrl` in the
   upload panel, `environment.profile(host)` on the settings page.

   Getters, not a snapshot. `readEnvironment()` is memoised on first call, so a
   frozen copy built at module-evaluation time would capture whatever `env.js`
   said before the script finished loading — and the answer to "what is the
   intake URL" must be the same for every reader regardless of when they asked. */
export const environment = {
  get intakeUrl() { return readEnvironment().intakeUrl; },
  get supabaseUrl() { return readEnvironment().supabaseUrl; },
  get supabasePublishableKey() { return readEnvironment().supabasePublishableKey; },
  get apiBaseUrl() { return readEnvironment().apiBaseUrl; },
  get deployment() { return readEnvironment().deployment; },
  get version() { return readEnvironment().version; },

  /** Which playback profile to preselect on the settings form when the server
      has not stored one yet.

      There is exactly one production profile — `balanced-540-v1`, the value the
      media ticket endpoint signs against (see functions/api/media/ticket.js).
      The parameter is accepted and ignored rather than being removed: the
      caller passes a hostname because the legacy built its default from one,
      and a later profile-per-host split would need the argument back. Returning
      a single constant today beats inventing a host table no endpoint reads. */
  profile(_host) {
    void _host;
    return 'balanced-540-v1';
  },
};
