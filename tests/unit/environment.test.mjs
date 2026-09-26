/* Asserts that public/env.js and src/config/environment.js agree on key names.

   This is the one bug class the build cannot catch. `env.js` is a plain object
   literal read at runtime; `environment.js` destructures it. A key spelled
   `supabaseAnonKey` on one side and `supabasePublishableKey` on the other
   produces no error anywhere in the toolchain — esbuild sees two unrelated
   files, and the browser only finds out when `assertSafeEnvironment()` throws
   and both apps render the fatal screen against a correctly configured project.
   That is exactly what shipped once.

   It also checks the two things env.js must never contain: the service role key
   and any of the server-only signing secrets. A leak here is public by
   definition — the file is served to every visitor. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/** Evaluate env.js the way the browser does, capturing the global it sets. */
function loadEnvFile() {
  const source = readFileSync(join(root, 'public', 'env.js'), 'utf8');
  const sandbox = { window: {} };
  sandbox.self = sandbox.window;
  runInNewContext(source, sandbox);
  const env = sandbox.window.__EASTUDY_ENV__;
  assert.ok(env, 'env.js 未定义 window.__EASTUDY_ENV__');
  return { env, source };
}

const { env, source } = loadEnvFile();

/** The keys environment.js reads, taken from its source rather than listed
    here. Hard-coding them would make this file a third place the names live,
    and the point is that there are only two.

    Two routes reach `env.js`, and both must be scanned. `readEnvironment()`
    spreads the raw object over FALLBACK, so every FALLBACK name is read. The
    `environment` export then exposes a second set through getters —
    `get deployment() { return readEnvironment().deployment; }` — and those names
    need not appear in FALLBACK at all. Scanning only FALLBACK reported
    `deployment` and `version` as junk keys when in fact the app reads both. */
function readKeysConsumedByClient() {
  const client = readFileSync(join(root, 'src', 'config', 'environment.js'), 'utf8');

  const fallback = /const FALLBACK = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(client);
  assert.ok(fallback, 'environment.js 里找不到 FALLBACK 定义');
  const fromFallback = [...fallback[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => match[1]);

  // `get name() { return readEnvironment().name; }` — the property after the
  // call is the key being read.
  const fromGetters = [...client.matchAll(/get\s+([A-Za-z_$][\w$]*)\s*\(\)\s*\{\s*return\s+readEnvironment\(\)\s*\.\s*([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[2]);

  return [...new Set([...fromFallback, ...fromGetters])];
}

test('env.js 提供 environment.js 读取的每一个键', () => {
  const consumed = readKeysConsumedByClient();
  assert.ok(consumed.length >= 5, `从 environment.js 只读到 ${consumed.length} 个键,解析可能已失效`);

  const missing = consumed.filter((key) => !(key in env));
  assert.deepEqual(
    missing,
    [],
    `env.js 缺少 environment.js 会读取的键:${missing.join('、')}。`
    + '键名不一致不会报错,只会让 assertSafeEnvironment() 在运行时抛错。',
  );
});

test('env.js 不含布局之外的多余键', () => {
  // The reverse direction matters less (an extra key is merely unused), but it
  // is how a rename leaves a stale twin behind: the new name gets added and the
  // old one stays, and the next reader cannot tell which is live.
  const consumed = new Set(readKeysConsumedByClient());
  const extra = Object.keys(env).filter((key) => !consumed.has(key));
  assert.deepEqual(extra, [], `env.js 里有多余的键:${extra.join('、')}`);
});

test('env.js 绝不包含服务端密钥', () => {
  // Name-based: a key whose name says service_role or secret must not be here at
  // all, whatever its value.
  const forbidden = /service_?role|secret|password|private_?key/i;
  const named = Object.keys(env).filter((key) => forbidden.test(key));
  assert.deepEqual(named, [], `env.js 出现疑似服务端字段:${named.join('、')}`);
});

test('env.js 的值里没有 service_role JWT', () => {
  // Value-based, because a key named innocuously can still hold a JWT. The
  // service role key is a JWT with a `role` claim; the anon key is also a JWT,
  // so length is the discriminator used elsewhere in this project and the same
  // one is used here. A real anon key is well under 200 characters.
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    const looksLikeJwt = value.startsWith('eyJ');
    assert.ok(
      !(looksLikeJwt && value.length > 200),
      `env.js 的 ${key} 看起来是 service_role 密钥。浏览器端只能放 anon/publishable key。`,
    );
  }

  // And the raw source, in case a value is assembled from pieces. Comments are
  // stripped first: env.js *docs* the rule ("the service_role key must never
  // appear here"), and a naive match on the raw text flagged that sentence as
  // the violation it warns against.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/SERVICE_ROLE|service_role/.test(code),
    'env.js 代码里出现 service_role 字样',
  );
});

test('本地回环地址之外没有硬编码的 intake 地址', () => {
  // The intake service is loopback-only by design; a non-loopback default here
  // would be a deployment reaching for a host it cannot see, or worse, a
  // suggestion that the service may be exposed publicly.
  const url = env.intakeUrl;
  if (!url) return;
  assert.match(
    url,
    /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/,
    `intakeUrl 指向非回环地址:${url}。该服务仅限本机,不得暴露在公网接口上。`,
  );
});

test('themes: env.js 只应有一条 window.__EASTUDY_ENV__ 赋值', () => {
  // Two assignments would mean the last one wins and the earlier block is dead —
  // usually a merge artifact, and the kind that makes a deployment look like it
  // ignored its configuration.
  const assignments = source.match(/window\.__EASTUDY_ENV__\s*=/g) ?? [];
  assert.equal(assignments.length, 1, 'env.js 里有多处 window.__EASTUDY_ENV__ 赋值');
});
