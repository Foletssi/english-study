/* Parses every JavaScript file in the repository, and asserts each edge route
   actually exports a handler.

   Two bug classes live here, and neither is visible to any other step:

   1. A syntax error in `functions/`. The build bundles `src/` with esbuild and
      copies `functions/` verbatim, so `npm run build` succeeds while
      `wrangler pages dev` fails to build Functions at all. That happened once,
      and the cause was a JSDoc that quoted PostgREST's empty-table
      `Content-Range` form: the literal `*` `/` `0` inside the comment closed it
      early and turned the rest of the paragraph into code. The Chinese prose
      that followed parsed as identifiers, so the error was not "unterminated
      comment" — which a human would recognise — but `Expected ";" but found
      "Prefer"` pointing at text that looks correct. Reading the diff cannot
      catch that; parsing the file can.

   2. A route file with no handler. Pages routes by filename, so a file that
      exports nothing still shadows the `[[path]]` catch-all and answers every
      request with a 404 that reads like a server fault. The file's presence
      suppresses the fallback; only the export makes the route work.

   Parsing goes through esbuild's own parser — the same one that bundles
   Functions in the Workers runtime — so this agrees with the deployment by
   construction rather than by approximation. `build` rather than `transform`,
   because the metafile that lists a module's exports is only produced by the
   former, and following imports means a broken relative path is reported here
   too. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/** Every `.js` file under `dir`, recursively. */
function jsFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

/** The `../` prefix a module at `file` must use to reach `functions/_lib`.

    Derived from directory depth rather than listed, because the bug this
    guards against is exactly a hand-written prefix that was never re-counted
    after a file moved into a subdirectory. Two routes shipped that way —
    `admin/subtitles/[[path]].js` and `media/ticket.js`, one `../` short each —
    and neither is visible to `npm run build`: `functions/` is copied, never
    bundled, so a bad import resolves only when the Workers runtime loads the
    file, which is to say in production. */
function libPrefix(file) {
  const depth = dirname(relative(root, file)).split(/[\\/]/).length - 1;
  return `${'../'.repeat(depth)}_lib/`;
}

/** Parse `file` and return the names it exports. Throws on a parse error.

    `bundle: true` so that a module whose imports do not resolve is reported as
    well — an edge function that imports `./missing.js` fails at deploy, and
    nothing else in the toolchain reads these files either. Output is discarded:
    this is a parse, not a build. */
function parse(file) {
  const result = buildSync({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    // Externals are the runtime-provided globals these handlers rely on; making
    // them external keeps the parse honest about what the file itself contains
    // without requiring a Workers shim here.
    external: ['node:*'],
    logLevel: 'silent',
    metafile: true,
  });

  const output = Object.values(result.metafile.outputs)[0];
  return output?.exports ?? [];
}

/** Rebuild esbuild's error text, since `logLevel: 'silent'` suppressed it.

    esbuild still formats the text into `message`; the structured `errors` array
    carries the line and column, so both are used and the message's own copy of
    the location is dropped rather than printed twice. */
function describeError(file, error) {
  const rel = relative(root, file);
  const errors = error?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return `${rel} ${error?.message ?? '解析失败'}`;
  }
  return errors
    .map((item) => {
      const where = item.location ? `:${item.location.line}:${item.location.column}` : '';
      const line = item.location?.lineText ? `\n    ${item.location.lineText.trim()}` : '';
      return `${rel}${where} ${item.text}${line}`;
    })
    .join('\n');
}

test('仓库内每个 .js 文件都能被解析', () => {
  // `functions/` is the one that matters — it is copied verbatim and never
  // bundled — but parsing the rest costs little and catches a typo in a file
  // that no entry point imports, which is how a broken helper hides until the
  // day someone wires it up.
  const dirs = ['functions', 'src', 'tools', 'tests', 'public/assets/vendor'];
  const files = dirs.flatMap((dir) => jsFiles(join(root, dir)));

  // A silently-empty walk would make this test pass by having nothing to check.
  assert.ok(files.length > 50, `只找到 ${files.length} 个 .js 文件,收集逻辑可能已失效`);
  assert.ok(
    files.some((file) => file.includes(join('functions', '_lib'))),
    'functions/ 未被收集到',
  );

  const failures = [];
  for (const file of files) {
    try {
      parse(file);
    } catch (error) {
      failures.push(describeError(file, error));
    }
  }

  assert.deepEqual(
    failures,
    [],
    `以下文件解析失败,边缘函数将无法部署:\n\n${failures.join('\n')}\n\n`
    + '注意:`npm run build` 不会发现这里的问题 —— 它只打包 src/,functions/ 是原样复制的。',
  );
});

test('每个边缘路由文件都导出了处理函数', () => {
  // Pages routes by path, so merely creating the file takes the path away from
  // the `[[path]]` catch-all. A file with no `onRequest*` export answers 404 to
  // every request that reaches it, and because the catch-all is shadowed there
  // is nothing left to handle it — the failure looks like a missing route even
  // though the route file is what is wrong.
  const api = join(root, 'functions', 'api');
  const routes = jsFiles(api);
  assert.ok(routes.length > 20, `只找到 ${routes.length} 个路由文件`);

  const handler = /^onRequest(Get|Post|Put|Patch|Delete|Options|Head)?$/;
  const failures = [];
  for (const file of routes) {
    const exports = parse(file);
    if (!exports.some((name) => handler.test(name))) {
      failures.push(
        `${relative(root, file)} 导出了 [${exports.join(', ')}],没有 onRequest / onRequest<Method>`,
      );
    }
  }

  assert.deepEqual(failures, [], `以下路由不会响应任何请求:\n\n${failures.join('\n')}`);
});

test('functions/ 里的 _lib 相对路径深度都正确', () => {
  // 84 imports today. Counting them is the point: a check that silently matched
  // nothing would pass while two routes stayed broken.
  const files = jsFiles(join(root, 'functions'));
  const failures = [];
  let seen = 0;

  for (const file of files) {
    const want = libPrefix(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]*_lib\/[^'"]*)['"]/g)) {
      seen += 1;
      if (!match[1].startsWith(want)) {
        failures.push(
          `${relative(root, file)} → ${match[1]}\n    应为 ${want}…`,
        );
      }
    }
  }

  assert.ok(seen > 50, `只扫到 ${seen} 处 _lib 引用,匹配逻辑可能已失效`);
  assert.deepEqual(
    failures,
    [],
    `以下 _lib 相对路径前缀错误(边缘函数加载时才报错):\n\n${failures.join('\n')}`,
  );
});

test('没有目录同时放着 index.js 和 [[path]].js', () => {
  // Measured, not assumed. A `[[path]].js` absorbs ZERO segments as well as
  // many, so it also serves its own parent path — which is exactly the path
  // `index.js` exists to answer. Confirmed against `wrangler pages dev` with a
  // handler that returns its own filename in a response header:
  //
  //     /api/probe        → probe/index.js        (index.js + [id].js: fine)
  //     /api/probe/abc    → probe/[id].js
  //     /api/shadow       → shadow/[[path]].js    ← index.js is dead code
  //     /api/shadow/abc   → shadow/[[path]].js
  //
  // Six directories in this repository were arranged that way. Five of them
  // happened to return 401 for an unrelated reason, which is why the defect
  // stayed invisible: the list route answered with a plausible error instead of
  // the list. `functions/api/catalog` had no such cover — its catch-all called
  // `requireUser` where the index route did not — so `/api/catalog`, a public
  // endpoint, demanded a token.
  //
  // `tests/contracts/route-map.js` cannot see this. Its `matches()` encodes the
  // opposite belief — that a catch-all needs at least one segment to absorb, and
  // is therefore never a rival for its parent path — so the route table it
  // derives looks correct while the deployment routes elsewhere. That comment is
  // the documentation this test replaces with a measurement. A filesystem check
  // is the only form of the rule that does not depend on the engine's opinion,
  // and it is the shape the bug actually takes: two files, one directory.
  const api = join(root, 'functions', 'api');
  const byDir = new Map();

  for (const file of jsFiles(api)) {
    const dir = dirname(file);
    const name = file.slice(dir.length + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(name);
  }

  const failures = [];
  for (const [dir, names] of byDir) {
    if (names.includes('index.js') && names.includes('[[path]].js')) {
      failures.push(
        `${relative(root, dir).split(sep).join('/')} — index.js 永远不会被调用,`
        + '请求会全部落到 [[path]].js',
      );
    }
  }

  assert.deepEqual(
    failures,
    [],
    '以下目录里的 index.js 是死代码(把 [[path]].js 改成 [id].js,或让它独占该前缀):\n\n'
    + failures.join('\n'),
  );
});

test('路由文件名只使用 Pages 认识的形式', () => {
  // Pages resolves `[id].js` as one dynamic segment and `[[path]].js` as a
  // catch-all. Anything else bracket-shaped — `[id.js]`, or a nested `[[a]]` —
  // is treated as a literal filename, so the route it was meant to create does
  // not exist and its catch-all sibling swallows the path.
  const api = join(root, 'functions', 'api');
  const segment = /^(\[\[[\w-]+\]\]|\[[\w-]+\]|[\w-]+)(\.\w+)?$/;

  const failures = jsFiles(api).filter((file) =>
    relative(api, file)
      .split(/[\\/]/)
      .some((part) => !segment.test(part)));

  assert.deepEqual(
    failures.map((file) => relative(root, file)),
    [],
    '以上路径含 Pages 不认识的段名形式',
  );
});
