#!/usr/bin/env node
/* Contract check: every path the client calls must exist as an edge route.

   This is the executable form of the student↔admin mapping audit. It reads the
   real source on both sides — `src/services/*` for the calls, `functions/api/*`
   for the routes — so it cannot drift the way a hand-written checklist does.

   Run:  node tests/contracts/student-admin-mapping.mjs
   Exit: 0 when every call resolves, 1 when something is missing or mismatched.

   An endpoint the client already speaks to but that is deliberately not written
   yet is marked at the call site with a `待实现` comment. That is the whole
   registry: there used to be a hand-maintained PENDING table here naming
   twenty-four endpoints, and by the time the build finished every one of them
   had been written, so the table was dead weight that would have gone on
   reporting a false "待实现 24" no matter what the code did. A marker next to
   the call it excuses cannot drift from the call it excuses.

   A marked call counts as work remaining, not as a break, unless --strict is
   passed — under --strict it fails the run like any other gap. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectClientCalls, collectRoutes, matches } from './route-map.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const strict = process.argv.includes('--strict');

const routes = collectRoutes(join(root, 'functions'));
const calls = collectClientCalls(join(root, 'src'));

const sourceDir = join(root, 'src');
const sourceCache = new Map();
function sourceOf(relativePath) {
  if (!sourceCache.has(relativePath)) {
    try {
      sourceCache.set(relativePath, readFileSync(join(sourceDir, relativePath), 'utf8'));
    } catch {
      sourceCache.set(relativePath, '');
    }
  }
  return sourceCache.get(relativePath);
}

/* Does the module excuse this call? An exported `pendingPaths` array is the
   precise form; the `待实现` marker in the source is the cheap one. Both are
   read from the file the call actually lives in, so an excuse cannot outlive
   the call it excuses. */
function isPending(call) {
  const source = sourceOf(call.file);
  if (new RegExp(`['"\`]${escapeRegExp(call.raw)}['"\`][^\\n]*待实现`).test(source)) return true;
  const list = source.match(/pendingPaths\s*=\s*\[([\s\S]*?)\]/);
  if (!list) return false;
  const paths = [...list[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((match) => match[1]);
  return paths.includes(call.raw) || paths.includes(call.path);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const matched = [];
const pending = [];
const missing = [];

/* The source of a route file, for the one question the route table cannot
   answer: does the catch-all that swallowed this path know the word in it? */
const routeSourceCache = new Map();
function routeSource(relativePath) {
  if (!routeSourceCache.has(relativePath)) {
    try {
      routeSourceCache.set(relativePath, readFileSync(join(root, 'functions', relativePath), 'utf8'));
    } catch {
      routeSourceCache.set(relativePath, '');
    }
  }
  return routeSourceCache.get(relativePath);
}

/* One line per distinct (path, verb): a service that calls the same endpoint
   from two code paths is one connection, not two. Declared before the loops
   because `absorbed` is folded off `matched` above the printout, and a
   function declared with `function` hoists fine but the count is read into a
   const, so the order here is load-bearing. */
function dedupe(entries) {
  const seen = new Set();
  return entries.filter(({ call }) => {
    const key = `${call.path}|${call.methods.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

for (const call of calls) {
  const candidates = routes.filter((candidate) => matches(candidate.path, call.path));

  // Most literal-segment wins, then deepest, then not-a-catch-all. This is how
  // Pages resolves a static sibling against a `[[path]]` catch-all: the
  // specific file takes the request. Without the staticCount tiebreak, the
  // catch-all answers for paths that belong to a not-yet-written sibling, and
  // a genuinely missing endpoint looks connected.
  const route = candidates.sort((a, b) =>
    (b.staticCount - a.staticCount)
    || (b.depth - a.depth)
    || (Number(a.catchAll) - Number(b.catchAll)))[0];

  // A gap is a gap whether or not anyone marked it: the marker changes which
  // column of the summary it lands in, not whether the run notices it. The
  // previous draft only consulted the pending table in the `!route` branch, so
  // a marked path that resolved to the *wrong* route (a catch-all standing in
  // for an unwritten sibling) would have been reported as connected.
  if (!route) {
    if (isPending(call)) pending.push({ call, note: '文件内已标注' });
    else missing.push({ call, reason: '没有任何路由匹配' });
    continue;
  }

  // A GET-only route answering a POST is a real break: the path resolves, the
  // request 405s. Callers whose verbs we could not infer are not judged.
  if (call.methods.length && route.methods.length && !call.methods.some((m) => route.methods.includes(m))) {
    missing.push({
      call,
      reason: `路由只支持 ${route.methods.join('/')},客户端调用 ${call.methods.join('/')}`,
    });
    continue;
  }

  matched.push({ call, route });
}

/* The other half of the story: whether the caller actually got the handler it
   named.

   `[[path]]` serves `/api/plans/<id>` — the caller substitutes a real id and
   the route is exactly right, even though the route file is named after the
   prefix rather than the id. Reporting those as suspicious produced fourteen
   lines of pure noise, one per legitimate catch-all.

   What IS worth naming is the opposite case: the caller wrote a *literal*
   segment — `api.post('/api/admin/videos/import')` — and only a catch-all
   matched. Pages will route that into the catch-all's handler, which knows
   nothing about `import`, so the response is a 404 that reads like a server
   fault. That is the shape a missing sibling actually takes, and it is what
   `staticCount` alone would have called 已接通.

   Computed here, after the loop, off the deduped set: folding it into the loop
   counted one entry per (path, verb) pair, so the summary printed a count that
   did not match the list printed below it. */
const absorbed = dedupe(matched.filter(({ call, route }) => {
  if (!route.catchAll) return false;
  // Only the segments the `**` actually swallows matter. Every path has
  // literal segments up front — `api`, `admin`, `videos` are text in all of
  // them — so asking whether the whole path contains a literal answers "yes"
  // for every call ever made and the filter matches nothing but noise. The
  // question is whether the *absorbed* tail is text the caller spelled out.
  const from = route.path.split('/').filter(Boolean).indexOf('**');
  const absorbedSegments = call.path.split('/').filter(Boolean).slice(from);
  const unknown = absorbedSegments.filter((segment, index) =>
    !call.templated[from + index] && !routeSource(route.file).includes(segment));
  if (!unknown.length) return false;
  return !routes.some((other) => !other.catchAll && matches(other.path, call.path));
}));

console.log('学员端 ↔ 控制端 契约检查');
console.log(`  客户端调用点   ${calls.length}`);
console.log(`  edge 路由      ${routes.length}`);
console.log(`  已接通         ${matched.length}`);
console.log(`  待实现         ${pending.length}`);
console.log(`  断链           ${missing.length}`);
if (absorbed.length) console.log(`  仅由 catch-all 兜底 ${absorbed.length}`);
console.log('');

if (matched.length) {
  console.log('已接通的接口:');
  for (const { call, route } of dedupe(matched)) {
    console.log(`  ✓ ${call.path.padEnd(42)} → ${route.file} [${route.methods.join('/') || '?'}]`);
  }
  console.log('');
}

if (absorbed.length) {
  console.log('仅由 catch-all 兜底(调用方写死了字面量,却没有同名文件接住):');
  for (const { call, route } of absorbed) {
    console.log(`  ! ${call.path.padEnd(42)} → ${route.file}`);
  }
  console.log('');
}

if (pending.length) {
  console.log('待实现(客户端已写好,文件内标注了待实现):');
  for (const { call } of dedupe(pending)) {
    console.log(`  · ${call.path.padEnd(42)} ${call.file}`);
  }
  console.log('');
}

if (missing.length) {
  console.log('断链(客户端调用了一个不存在或不接受该方法的端点):');
  for (const { call, reason } of missing) {
    console.log(`  ✗ ${call.path.padEnd(42)} ${call.file}`);
    console.log(`      ${reason}`);
  }
  console.log('');
}

/* The verdict is derived, not written. It used to be a fixed ternary whose
   passing arm read 「通过(存在待实现接口,非断链)」 — which meant a run that
   genuinely had marked-and-unimplemented endpoints reported the same sentence
   as a clean one, and the sentence was the only place that state appeared. */
const failed = missing.length > 0 || (strict && pending.length > 0);
if (failed) {
  const reasons = [];
  if (missing.length) reasons.push(`${missing.length} 条断链`);
  if (strict && pending.length) reasons.push(`${pending.length} 条待实现(--strict)`);
  console.log(`结果:未通过(${reasons.join('；')})`);
} else if (pending.length) {
  console.log(`结果:通过(存在 ${pending.length} 条待实现接口,非断链)`);
} else {
  console.log('结果:通过(全部已实现)');
}
process.exit(failed ? 1 : 0);
