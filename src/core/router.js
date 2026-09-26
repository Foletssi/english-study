/* Eastudy V3 — hash router.

   Each page owns its own mount and unmount, so leaving a page stops its timers,
   HLS instances and observers without the router needing to know what any of
   them are. The legacy left video elements, intervals and fetch loops running
   after navigation.

   The contract, which is what the sixteen page modules and both entries are
   written against:

     createRouter({ container, routes, fallback, onError, onNavigate })

     `routes` is a plain object mapping a path pattern to a factory:
         { '/': (ctx) => createHomePage(...), '/watch/:id': (ctx) => ... }
     The factory returns a page object `{ root, mount(), unmount() }`. The
     router inserts `root` into `container` and calls `mount()`; on the next
     navigation it calls `unmount()` and drops the node.

   This file previously described a different contract — `routes` as an ARRAY
   of `{ path, view }`, `view(ctx)` returning a teardown function or a
   `{ dispose }` handle, and no insertion of `root` at all. Nothing on either
   side of it was ever written that way, and the mismatch was invisible to the
   test suite because no test mounts a page: `for (const route of routes)` threw
   `routes is not iterable` on an object literal, inside a promise nobody
   awaited, so the shell rendered, the outlet stayed empty, and the console
   stayed silent. Every page was reachable only through its own URL fragment
   and none of them ever painted. */

import { emit, EVENTS } from './bus.js';

function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  return {
    path: path.startsWith('/') ? path : `/${path}`,
    query: Object.fromEntries(new URLSearchParams(search)),
  };
}

/** Split into segments; `/videos/:id` -> ['videos', ':id'] */
function segments(path) {
  return path.split('/').filter(Boolean);
}

function matchRoute(pattern, path) {
  const want = segments(pattern);
  const have = segments(path);
  if (want.length !== have.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      params[want[i].slice(1)] = decodeURIComponent(have[i]);
    } else if (want[i] !== have[i]) {
      return null;
    }
  }
  return params;
}

export function createRouter({ container, routes, fallback = null, onError = null, onNavigate = null }) {
  let teardown = null;
  let current = null;
  let token = 0;
  // Snapshot the table once: `routes` is an object literal at every call site,
  // and iterating it per navigation would depend on the caller not mutating it.
  const table = Object.entries(routes ?? {});

  function resolve(path) {
    // Insertion order decides ties, and the patterns are declared most-specific
    // first at the call sites. Segment counts are compared before anything else,
    // so `/admin/learners/:id` cannot swallow `/admin/learners`.
    for (const [pattern, view] of table) {
      const params = matchRoute(pattern, path);
      if (params) return { pattern, view, params };
    }
    return null;
  }

  async function render() {
    const { path, query } = parseHash(location.hash);
    const found = resolve(path);
    const mine = ++token;

    if (teardown) {
      try { teardown(); } catch (error) { console.error('[router] 清理失败', error); }
      teardown = null;
    }

    const ctx = {
      container, path, query,
      params: found?.params ?? {},
      navigate: (to, options) => service.navigate(to, options),
    };

    let page;
    try {
      page = found
        ? await found.view(ctx)
        : (fallback ? await fallback(ctx) : null);
    } catch (error) {
      report(error, path);
      current = { path, params: ctx.params, query, pattern: found?.pattern ?? null };
      onNavigate?.(path);
      return current;
    }

    // A slower earlier navigation must not overwrite a newer one. Its page has
    // already been constructed, so its teardown has to run here or its timers
    // outlive the navigation that started them.
    if (mine !== token) {
      close(page);
      return current;
    }

    if (page?.root) container.replaceChildren(page.root);
    if (typeof page?.mount === 'function') {
      try { await page.mount(); } catch (error) { report(error, path); }
    }

    teardown = () => close(page);
    current = { path, params: ctx.params, query, pattern: found?.pattern ?? null };
    onNavigate?.(path);
    emit(EVENTS.ROUTE_CHANGED, current);
    return current;
  }

  /** Run whichever teardown the page declared. `unmount` is the name all
      sixteen modules use; the two alternatives are accepted so a page written
      before this contract settled still releases what it holds. */
  function close(page) {
    if (!page) return;
    const dispose = typeof page === 'function'
      ? page
      : (page.unmount ?? page.dispose ?? null);
    if (typeof dispose === 'function') {
      try { dispose(); } catch (error) { console.error('[router] 卸载失败', error); }
    }
  }

  function report(error, path) {
    if (onError) { onError(error, path); return; }
    console.error(`[router] 渲染 ${path} 失败`, error);
  }

  const service = {
    async start() {
      window.addEventListener('hashchange', render);
      await render();
      return current;
    },
    stop() {
      window.removeEventListener('hashchange', render);
      if (teardown) { try { teardown(); } catch {} teardown = null; }
    },
    render,
    navigate(to, { replace = false } = {}) {
      const target = to.startsWith('#') ? to : `#${to}`;
      if (location.hash === target) return render();
      if (replace) {
        // replaceState does not fire hashchange, so render explicitly.
        history.replaceState(null, '', target);
        return render();
      }
      location.hash = target;
      return Promise.resolve(current);
    },
    get current() { return current; },
  };

  return service;
}
