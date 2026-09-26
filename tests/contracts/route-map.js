/* Derive the route table from the filesystem, and the client's calls from the
   service modules. Both readers live here so the contract test and the audit
   report agree on what "a route" and "a call" are. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const HTTP_METHODS = ['onRequestGet', 'onRequestPost', 'onRequestPut', 'onRequestPatch', 'onRequestDelete'];

/** Walk functions/api and turn each file into a route pattern.
    Cloudflare Pages maps:
      functions/api/catalog.js               → /api/catalog
      functions/api/catalog/index.js         → /api/catalog
      functions/api/media/ticket.js          → /api/media/ticket   (static sibling)
      functions/api/media/[[path]].js        → /api/media/*        (catch-all)
      functions/api/admin/videos/[id].js     → /api/admin/videos/:id
      functions/api/admin/learners/[id].js   → /api/admin/learners/:id

    Note the two `[id].js` above, and what is NOT in this list: no directory
    pairs an `index.js` with a `[[path]].js`. That pairing was a real defect in
    six directories here, and this reader cannot see it — see `matches`. */
export function collectRoutes(functionsDir) {
  const routes = [];
  const apiRoot = join(functionsDir, 'api');
  for (const file of listJs(apiRoot)) {
    // Relative to the api root, so `/api/admin/videos/index.js` becomes
    // `admin/videos/index` and not just `index`.
    const rel = relative(apiRoot, file).split(sep).join('/');
    const source = readFileSync(file, 'utf8');
    const methods = HTTP_METHODS.filter((name) => new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(source));

    const segments = rel.replace(/\.js$/, '').split('/');
    if (segments[segments.length - 1] === 'index') segments.pop();

    const pattern = [];
    for (const segment of segments) {
      if (segment.startsWith('[[[') || segment.startsWith('[[')) { pattern.push('**'); continue; }
      if (segment.startsWith('[')) { pattern.push(`:${segment.replace(/[[\]]/g, '')}`); continue; }
      pattern.push(segment);
    }

    routes.push({
      file: relative(functionsDir, file).split(sep).join('/'),
      // `/api` is the mount point of the functions/api tree; the client calls
      // the full path, so the pattern has to include it.
      path: `/api/${pattern.join('/')}`,
      // Segment count excluding the leading empty string, so `matches` can
      // compare it against a client path split the same way.
      depth: pattern.filter(Boolean).length,
      // How many segments are literal text rather than `:param` or `**`. This
      // is what makes `/api/media/ticket` outrank `/api/media/**`, and it is
      // the discriminator a catch-all has to lose on.
      staticCount: pattern.filter((segment) => segment !== '**' && !segment.startsWith(':')).length,
      catchAll: pattern.includes('**'),
      methods: methods.map((m) => m.replace('onRequest', '').toUpperCase()),
    });
  }
  return routes;
}

const STRING_LITERAL = /['"`](\/api\/[^'"`]*)['"`]/g;

/** Find every path literal a module hands to the api client, plus the HTTP
    verb from the surrounding call. Template placeholders become `:p` so a
    client path and a route pattern can be compared segment by segment.

    A querystring is stripped before that comparison. A route pattern never
    contains one — the match is on the path — and leaving `?video_id=:p` on the
    end made the last segment `preview?video_id=:p`, which no route can equal.
    The static sibling therefore dropped out of the candidate list and the
    `[[path]]` catch-all answered instead, so the report named the wrong file
    for every call that carries parameters, and would have called a missing
    sibling "connected" whenever a catch-all shared its prefix. */
export function collectClientCalls(sourceDir) {
  const calls = [];
  for (const file of listJs(sourceDir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(STRING_LITERAL)) {
      const raw = match[1];
      const pathOnly = raw.split('?')[0].replace(/\/+$/, '');
      const path = pathOnly.replace(/\$\{[^}]*\}/g, ':p');
      const before = source.slice(Math.max(0, match.index - 220), match.index);
      calls.push({
        file: relative(sourceDir, file).split(sep).join('/'),
        raw,
        path,
        // Which segments the author wrote as a template hole rather than as
        // text. A hole is the caller saying "an id goes here", which is exactly
        // what a `[[path]]` route exists to answer; a literal is the caller
        // naming a specific endpoint, and if only a catch-all picks it up then
        // the sibling file that should own it is missing. The two cases look
        // identical in `path`, and telling them apart is the whole difference
        // between a useful report and fourteen false alarms.
        //
        // Read off `path` (post-substitution), not `pathOnly`: the raw string
        // holds `${id}`, so comparing its segments against `:p` marked every
        // hole as a literal and the filter matched everything.
        templated: path.split('/').filter(Boolean).map((segment) => segment === ':p'),
        methods: nearbyMethods(before),
      });
    }
  }
  return calls;
}

function nearbyMethods(before) {
  const found = new Set();
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    if (new RegExp(`api\\.${method}\\s*\\(\\s*$`).test(before)) found.add(method.toUpperCase());
  }
  if (!found.size && /api\.get\s*\([^)]*$/.test(before)) found.add('GET');
  return [...found];
}

function listJs(dir) {
  const out = [];
  const entries = (() => { try { return readdirSync(dir); } catch { return []; } })();
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJs(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Does a concrete client path (`/api/media/subtitles/:p`) match a route
    pattern (`/api/media/**`)?

    A non-catch-all route matches only at exactly its own depth: Pages routes
    `/api/admin/videos` to `videos/index.js` and `/api/admin/videos/<id>` to
    `videos/[id].js`, and those must not be interchangeable. Returning true
    for a shorter pattern would let a catch-all answer for a path whose real
    handler is simply missing. */
export function matches(routePath, clientPath) {
  const routeParts = routePath.split('/').filter(Boolean);
  const clientParts = clientPath.split('/').filter(Boolean);

  const catchAllAt = routeParts.indexOf('**');
  if (catchAllAt === -1 && routeParts.length !== clientParts.length) return false;
  // MODELLING CHOICE, NOT A RULE OF THE ENGINE. `wrangler pages dev` was probed
  // with a handler that reports its own filename, and a `[[path]].js` absorbs
  // ZERO segments as well as many — so it also serves its own parent path, and a
  // sibling `index.js` beside it is dead code that never runs.
  //
  //     /api/shadow       → shadow/[[path]].js    ← index.js never runs
  //     /api/shadow/abc   → shadow/[[path]].js
  //
  // This line asserts the opposite, which is why six shadowed routes shipped
  // green: the derived table looked right while the deployment routed elsewhere.
  // It is kept because on a tree where no such pairing exists it makes no
  // difference, and because a catch-all still must not answer for the bare
  // prefix of a route that has no handler. It is NOT the guard — that is the
  // filesystem check in tests/unit/syntax.test.mjs, which cannot encode a wrong
  // belief about the engine. Do not read this as documentation of Pages.
  if (catchAllAt !== -1 && clientParts.length <= catchAllAt) return false;

  for (let i = 0; i < routeParts.length; i += 1) {
    const routePart = routeParts[i];
    if (routePart === '**') return true;
    const clientPart = clientParts[i];

    // `:p` is a template placeholder: at runtime a real id is substituted there.
    // It matches a `:param` route — and it must NOT match a literal segment.
    // `/api/vocabulary/${id}` cannot be served by `api/vocabulary/follow.js`,
    // because the request path carries an id, not the word "follow". Treating it
    // as a match let that static sibling win the specificity tiebreak, so a
    // DELETE that resolves correctly at runtime was reported as a broken link.
    if (clientPart === ':p') {
      if (!routePart.startsWith(':')) return false;
      continue;
    }
    if (routePart.startsWith(':')) continue;
    if (routePart !== clientPart) return false;
  }
  return routeParts.length === clientParts.length;
}
