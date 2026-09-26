/* Eastudy V3 — student catalog.

   Students never query the videos table directly. Everything they see comes
   from /api/catalog, which is hard-filtered to
   `status = PUBLISHED and visibility = public` on the server, so a mistake in
   a student-side filter cannot surface a draft. */

import { EVENTS, emit } from '../core/bus.js';

export function createCatalogService({ api }) {
  const cache = new Map();

  function cacheKey(params) {
    return JSON.stringify(params);
  }

  async function list({ page = 1, pageSize = 24, q = '', category = '', level = '', sort = 'recent', useCache = true } = {}) {
    const params = { page, pageSize, q, category, level, sort };
    const key = cacheKey(params);
    if (useCache && cache.has(key)) return cache.get(key);

    const result = await api.get('/api/catalog', { query: params });
    if (useCache) cache.set(key, result);
    return result;
  }

  async function facets() {
    const result = await api.put('/api/catalog', {});
    return result;
  }

  async function detail(videoId) {
    return api.get(`/api/catalog/${encodeURIComponent(videoId)}`);
  }

  function invalidate() {
    cache.clear();
    emit(EVENTS.CATALOG_CHANGED, { reason: 'manual' });
  }

  return { list, facets, detail, invalidate, get size() { return cache.size; } };
}
