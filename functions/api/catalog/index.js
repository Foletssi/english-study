/* GET /api/catalog — the student catalog projection.

   One endpoint, one shape. The student client never queries `videos` directly:
   it would then have to reimplement the published/visibility filter in every
   screen, and a mistake there leaks drafts to learners. Everything a student
   screen renders comes from here, paged.

   Deliberately excluded from the projection: source paths, job ids, worker
   output, review state and any other operator-side field. */

import { errorResponse, json } from '../../_lib/env.js';
import { createClient } from '../../_lib/supabase.js';
import { listResponse, readPaging, readTotal } from '../../_lib/paging.js';

const PUBLIC_COLUMNS = [
  'id', 'title', 'subtitle', 'description', 'category_id', 'level',
  'duration_seconds', 'cover_url', 'tags', 'speaker', 'accent', 'published_at',
].join(',');

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const { page, pageSize, offset } = readPaging(url, { defaultPageSize: 24, maxPageSize: 60 });
    const category = url.searchParams.get('category');
    const level = url.searchParams.get('level');
    const search = url.searchParams.get('q');
    const sort = url.searchParams.get('sort') === 'oldest' ? 'published_at.asc' : 'published_at.desc';

    const filters = [
      `select=${PUBLIC_COLUMNS}`,
      'status=eq.PUBLISHED',
      'visibility=eq.public',
      `order=${sort}`,
      `limit=${pageSize}`,
      `offset=${offset}`,
    ];
    if (category) filters.push(`category_id=eq.${encodeURIComponent(category)}`);
    if (level) filters.push(`level=eq.${encodeURIComponent(level)}`);
    if (search) {
      const term = encodeURIComponent(`*${search}*`);
      filters.push(`or=(title.ilike.${term},subtitle.ilike.${term},description.ilike.${term})`);
    }

    const client = createClient(env);
    // `call` rather than `select`: the count only arrives on the response
    // headers, and `select` hands back the array alone. The first draft set
    // `Prefer: count=exact` on a call whose headers nobody read, so the pager
    // had no total to render from.
    const response = await client.call(`videos?${filters.join('&')}`, {
      headers: { Prefer: 'count=exact' },
    });
    const rows = Array.isArray(response) ? response : [];

    return listResponse({
      rows,
      total: readTotal(response, rows),
      page,
      pageSize,
      // Still cacheable: the count is part of the same representation, so a
      // cached page carries a cached total and the two cannot disagree.
      headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** PUT /api/catalog — the taxonomy the student filter bar renders.

   Same reason as above: the category list is part of the catalog contract, not
   a separate thing the student client guesses at. */
export async function onRequestPut({ env }) {
  try {
    const client = createClient(env);
    const [categories, levels] = await Promise.all([
      client.select('categories', 'select=id,name,sort_order&order=sort_order.asc').catch(() => []),
      client.select('videos', 'select=level&status=eq.PUBLISHED&level=not.is.null').catch(() => []),
    ]);
    const counts = new Map();
    for (const row of levels ?? []) {
      if (row.level) counts.set(row.level, (counts.get(row.level) || 0) + 1);
    }
    return json({
      categories: categories ?? [],
      levels: Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
