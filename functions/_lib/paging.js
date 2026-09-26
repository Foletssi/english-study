/* Eastudy V3 — one pagination vocabulary for every list endpoint.

   The gap this closes: the client services send `page`/`pageSize`, while the
   first draft of these handlers read `limit`/`offset`. Nothing errored — the
   server silently used its defaults, so page 3 returned page 1's rows. A
   naming mismatch that produces plausible data is worse than one that 500s.

   So: the wire format is `page`/`pageSize` everywhere, PostgREST's
   `limit`/`offset` is derived here, and both spellings are accepted on input
   so a hand-written curl using `limit` still works. */

import { json } from './env.js';

export const MAX_PAGE_SIZE = 100;

export function readPaging(url, { defaultPageSize = 24, maxPageSize = MAX_PAGE_SIZE } = {}) {
  const params = url.searchParams;

  let pageSize = Number(params.get('pageSize') ?? params.get('page_size') ?? NaN);
  if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = defaultPageSize;
  pageSize = Math.min(Math.floor(pageSize), maxPageSize);

  let page = Number(params.get('page') ?? NaN);
  if (!Number.isFinite(page) || page <= 0) {
    // Fall back to offset when a caller paged the PostgREST way.
    const offset = Number(params.get('offset') ?? NaN);
    page = Number.isFinite(offset) && offset > 0 ? Math.floor(offset / pageSize) + 1 : 1;
  }
  page = Math.floor(page);

  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

/** PostgREST returns the window in Content-Range as `0-19/137`, or as an
    asterisk over a slash followed by `0` when the table is empty. (Spelled out
    rather than quoted: the literal form ends in the two characters that close a
    block comment, which silently ended this one and turned the rest of this
    sentence into code — see tests/unit/syntax.test.mjs.)

    The first draft set `Prefer: count=exact` and then never read the header, so
    every list rendered without a total. */
export function readTotal(response, rows) {
  const range = response?.headers?.get?.('Content-Range') || '';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : (rows?.length ?? 0);
}

/** The envelope every list endpoint returns, so a client can render a pager
    without special-casing one route. */
export function listResponse({ rows, total, page, pageSize, extra = {}, headers = {} }) {
  const count = total ?? rows?.length ?? 0;
  return json({
    rows: rows ?? [],
    total: count,
    page,
    pageSize,
    hasMore: page * pageSize < count,
    ...extra,
  }, { headers });
}
