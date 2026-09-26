/* Eastudy V3 — runtime environment.

   This file is the ONLY place that changes between deployments, and the build
   rewrites it from the environment it is given. Everything else in the bundle
   is identical between staging and production, which means a deploy is
   verifiable by diffing one file.

   It deliberately contains no secret. The local intake service is reached over
   loopback from the operator's own browser, so its address is configuration,
   not a credential; the handshake that authorises an upload is minted
   server-side per request.

   The key names below are read by src/config/environment.js and must match it
   exactly. They did not, once: this file said `supabaseAnonKey` and `apiBase`
   while the client asked for `supabasePublishableKey` and `apiBaseUrl`, so
   `assertSafeEnvironment()` threw "未配置" on every boot and both apps rendered
   the fatal screen against a correctly configured project. There is no build
   step that can catch a name written twice and spelled once, so the pairing is
   asserted by tests/unit/environment.test.mjs instead. */

window.__EASTUDY_ENV__ = {
  // Same-origin by default: the edge API ships with the site.
  apiBaseUrl: '',

  // The local processing intake service. Loopback only — it must never be
  // exposed on a public interface, and the edge API cannot reach it.
  intakeUrl: 'http://127.0.0.1:8790/v3',

  // Supabase project. The anon (publishable) key is public by design; row level
  // security is what protects the data. The service_role key must never appear
  // here, and the build refuses to write one.
  supabaseUrl: '',
  supabasePublishableKey: '',

  // Free-text label shown in the console so an operator can tell at a glance
  // which deployment they are looking at.
  deployment: 'local',
  version: '3.0.0',
};
