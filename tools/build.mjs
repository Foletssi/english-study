#!/usr/bin/env node
/* Eastudy V3 — build.

   Produces `dist/`, which is exactly what gets uploaded: the static shell from
   `public/`, the two bundles the HTML entry points ask for, and the edge
   functions copied verbatim.

   Two things this deliberately does NOT do:

   1. It does not bundle the vendor scripts. `hls.min.js`, `supabase.js` and
      `sha256.js` are already-built globals, loaded by their own <script> tags
      in the source HTML. Running them through esbuild would rewrite code we did
      not write and cannot read the diff of, and the whole reason they are
      vendored rather than pulled from a CDN is to keep the deployed bytes
      identical to the ones we reviewed.

   2. It does not minify by default. A production deploy should pass `--minify`;
      leaving it off keeps stack traces readable while developing against
      `wrangler pages dev`, and the size difference on this bundle is not worth
      an unreadable production error.

   Usage:
     node tools/build.mjs                 → dist/, unminified, sourcemaps
     node tools/build.mjs --minify        → dist/, minified
     node tools/build.mjs --watch         → rebuild bundles on change
     node tools/build.mjs --out=build     → different output directory */

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const minify = args.includes('--minify');
const watch = args.includes('--watch');
const outArg = args.find((arg) => arg.startsWith('--out='));
const outDir = join(root, outArg ? outArg.slice('--out='.length) : 'dist');

/* The two entry points the HTML shells reference. The output names are not
   negotiable without editing the HTML too, which is why they are written here
   as a table rather than derived.

   `out` is a basename WITHOUT the extension: esbuild appends `.js` itself, so
   writing `assets/app.js` here produced `assets/app.js.js` — a file the HTML
   never asks for, and a 404 that only shows up in a browser. */
const ENTRIES = [
  { in: 'src/app/student-main.js', out: 'assets/app' },
  { in: 'src/app/admin-main.js', out: 'admin/admin' },
];

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // 1. The static shell. `env.js` comes along unmodified and is rewritten in
  //    step 3 — copying first means a failed rewrite leaves a deployable tree
  //    rather than a half-copied one.
  await cp(join(root, 'public'), outDir, { recursive: true });

  // 2. The edge functions are deliberately NOT copied here, and this is worth
  //    spelling out because copying them was the previous behaviour.
  //
  //    `wrangler pages deploy dist` reads Functions from `<cwd>/functions` —
  //    see the fallback in wrangler's own upload path, `customFunctionsDirectory
  //    || join(process.cwd(), 'functions')`. Nothing about `dist/` is consulted.
  //    Measured, not assumed: with `dist/functions/` moved away entirely,
  //    `wrangler pages dev dist` still served `/api/catalog` from the root copy.
  //
  //    So the copy was redundant — and it was also a leak. `_routes.json`
  //    includes only `/api/*`, so `dist/functions/**` is never routed to the
  //    Worker; it falls through to static assets and is published. Every file in
  //    the tree below was fetchable at a predictable path, `_lib/supabase.js`
  //    and its query helpers included:
  //
  //        GET /functions/_lib/env.js        200 OK
  //        GET /functions/_lib/supabase.js   200 OK
  //        GET /functions/api/media/ticket.js 200 OK
  //
  //    No secret is among them — the keys are dashboard environment variables,
  //    never files — but backend source has no reason to ship. `assertClean`
  //    below keeps it gone.

  // 3. The bundles.
  const options = {
    entryPoints: ENTRIES.map((entry) => ({ in: join(root, entry.in), out: entry.out })),
    outdir: outDir,
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    splitting: true,
    // Charting/logging packages are not used here; this keeps esbuild from
    // reaching for a Node shim in a browser bundle.
    platform: 'browser',
    minify,
    sourcemap: minify ? false : 'linked',
    logLevel: 'info',
    // The vendor globals are `window` properties by design (see above), so they
    // must stay external or esbuild would fail to resolve them at build time.
    external: [],
  };

  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('watching…');
    return;
  }

  await build(options);
  await writeEnv();
  await assertClean();
  console.log(`\n构建完成 → ${outDir}`);
}

/* What must never reach the published tree. Checked after the build rather than
   trusted to a comment: the previous build copied `functions/` in, and a
   deliberate change plus a regression of that change look identical in a diff
   six months later. `dist/` is uploaded verbatim, so a stray tree here is a
   stray tree served to visitors.

   `functions/` is the one that was actually wrong. It is listed with its
   reason so the next person does not re-add the copy thinking deploy needs it —
   it does not; see step 2. */
const FORBIDDEN_IN_OUTPUT = [
  { path: 'functions', why: '边缘函数源码。Pages 从项目根的 functions/ 读取,部署时不需要它出现在 dist/;而且 _routes.json 只把 /api/* 交给 Functions,/functions/** 会被当成静态资源公开' },
];

async function assertClean() {
  const failures = [];
  for (const { path, why } of FORBIDDEN_IN_OUTPUT) {
    if (existsSync(join(outDir, path))) failures.push(`${path}/ — ${why}`);
  }
  if (failures.length) {
    throw new Error(
      '产出目录里有不该发布的文件,dist/ 会被原样上传:\n\n'
      + failures.map((line) => `  ${line}`).join('\n'),
    );
  }
}

/* `env.js` is the one file that differs between deployments (see its own
   header). Everything the runtime needs comes from the environment, so a deploy
   is verifiable by diffing this single file — which only holds if the build
   actually writes it. */
async function writeEnv() {
  const target = join(outDir, 'env.js');
  const source = await readFile(join(root, 'public', 'env.js'), 'utf8');

  // These keys are matched literally against the lines in public/env.js, so a
  // rename on either side is a build failure rather than a silently unrewritten
  // value (see the header of that file).
  const values = {
    apiBaseUrl: process.env.EASTUDY_API_BASE ?? '',
    intakeUrl: process.env.EASTUDY_INTAKE_URL ?? 'http://127.0.0.1:8790/v3',
    supabaseUrl: process.env.EASTUDY_SUPABASE_URL ?? '',
    supabasePublishableKey:
      process.env.EASTUDY_SUPABASE_ANON_KEY ??
      process.env.EASTUDY_SUPABASE_PUBLISHABLE_KEY ??
      '',
    deployment: process.env.EASTUDY_DEPLOYMENT ?? 'local',
    version: process.env.EASTUDY_VERSION ?? '3.0.0',
  };

  // A service-role key in the browser bundle is a credential leak with a
  // one-line fix, so it is worth refusing to build rather than shipping it and
  // hoping nobody looks. The client asserts the same thing at runtime; failing
  // here means the bad deploy never exists.
  if (values.supabasePublishableKey.startsWith('eyJ') && values.supabasePublishableKey.length > 200) {
    throw new Error(
      'EASTUDY_SUPABASE_ANON_KEY 看起来是 service_role 密钥(过长)。'
      + '浏览器端只能使用 anon/publishable key —— 构建已中止。',
    );
  }

  let out = source;
  for (const [key, value] of Object.entries(values)) {
    // `||` rather than `??`: an unset variable here means the local default,
    // not an empty deployment override.
    const literal = JSON.stringify(value);
    const pattern = new RegExp(`(^\\s*${key}:\\s*)(['"\`])[^'"\`]*\\2(,?)$`, 'm');
    if (!pattern.test(out)) {
      throw new Error(`env.js 里找不到 ${key} 这一行,无法按部署目标写入`);
    }
    out = out.replace(pattern, `$1${literal}$3`);
  }

  await writeFile(target, out, 'utf8');
  console.log(`env.js 已写入(${values.deployment})`);
}

if (!existsSync(join(root, 'src')) || !existsSync(join(root, 'public'))) {
  throw new Error('请在项目根目录运行:node tools/build.mjs');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
