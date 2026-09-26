/* What the build must NOT put in `dist/`.

   `wrangler pages deploy dist` uploads that directory verbatim, so anything in
   it is public. The rule this file enforces was learned the hard way: the build
   used to copy `functions/` in, and because `_routes.json` includes only
   `/api/*`, nothing under `/functions/**` is ever routed to the Worker — it
   falls through to static assets. Every edge function was fetchable:

       GET /functions/_lib/env.js         200 OK
       GET /functions/_lib/supabase.js    200 OK
       GET /functions/api/media/ticket.js 200 OK

   That copy looked like it was doing necessary work. It was not, and the way to
   know is a measurement rather than an argument about how Pages resolves
   things: with `dist/functions/` moved away entirely, `wrangler pages dev dist`
   still served `/api/catalog` from the root copy — Pages reads Functions from
   `<cwd>/functions` and never consults `dist/`.

   `tools/build.mjs` asserts the same thing and refuses to build. This is the
   second gate because only one of the two always runs: a deploy that skips
   `npm run build` and uploads an existing `dist/` would never reach the build's
   own check. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dist = join(root, 'dist');

/** Skipped rather than failed when there is no build to inspect: this checks an
    artifact, and `npm run test` runs before `npm run build` in the `check`
    script. A test that failed when nothing had been built yet would force the
    two scripts into an order that is easy to break. */
const built = existsSync(dist);

test('dist/ 里没有边缘函数源码', { skip: built ? false : '尚未构建(dist/ 不存在)' }, () => {
  const stray = ['functions', '_worker.js', 'node_modules']
    .filter((entry) => existsSync(join(dist, entry)));

  assert.deepEqual(
    stray,
    [],
    `以下内容会随 dist/ 一起上传并被公开访问:\n\n${stray.join('\n')}\n\n`
    + 'functions/ 不是部署产物 —— Pages 从项目根的 functions/ 读取,'
    + '放进 dist/ 只会让 _lib/ 里的后端源码变成可下载的静态文件。',
  );
});

test('dist/env.js 里没有服务端密钥', { skip: built ? false : '尚未构建(dist/ 不存在)' }, () => {
  // The build refuses to write a service-role key and the client asserts the
  // same at runtime, so this is the third gate on the one credential that would
  // actually be a breach. It reads the built file rather than the source,
  // because the source is not what ships: `writeEnv` rewrites every value from
  // the environment, and a wrong `EASTUDY_SUPABASE_ANON_KEY` is a build-time
  // input that the source copy cannot speak for.
  const source = readFileSync(join(dist, 'env.js'), 'utf8');

  const values = [...source.matchAll(/^\s*\w+:\s*(['"`])([^'"`]*)\1,?$/gm)].map((match) => match[2]);
  const leaked = values.filter((value) => value.startsWith('eyJ') && value.length > 200);

  assert.deepEqual(
    leaked.map((value) => `${value.slice(0, 12)}…(${value.length} 字符)`),
    [],
    'dist/env.js 里出现了看起来是 service_role 的密钥 —— 它会发给每一位访客。',
  );
});
