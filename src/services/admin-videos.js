/* Eastudy V3 — admin video CRUD client (M07).

   The server owns the state machine and the field contract; this module only
   carries the request and re-throws the server's conflict payload so a page can
   show "someone else edited this" with the fresh row. */

import { EVENTS, emit } from '../core/bus.js';

export function createAdminVideosService({ api }) {
  async function list({ page = 1, pageSize = 20, status = '', q = '', category = '' } = {}) {
    return api.get('/api/admin/videos', { query: { page, pageSize, status, q, category } });
  }

  async function create(payload) {
    const result = await api.post('/api/admin/videos', payload, { retry: false });
    emit(EVENTS.CATALOG_CHANGED, { reason: 'admin:create' });
    return result;
  }

  async function get(videoId) {
    return api.get(`/api/admin/videos/${encodeURIComponent(videoId)}`);
  }

  /** `revision` is required: the server compares it and returns 409 with the
      current row when another operator saved first. */
  async function update(videoId, patch, revision) {
    const result = await api.patch(`/api/admin/videos/${encodeURIComponent(videoId)}`, {
      ...patch,
      revision,
    }, { retry: false });
    emit(EVENTS.CATALOG_CHANGED, { reason: 'admin:update', videoId });
    return result;
  }

  async function setStatus(videoId, status, revision) {
    return update(videoId, { status }, revision);
  }

  async function publish(videoId, revision) {
    return setStatus(videoId, 'PUBLISHED', revision);
  }

  async function archive(videoId, revision, reason) {
    const result = await update(videoId, { status: 'ARCHIVED' }, revision);
    if (reason) await api.post(`/api/admin/videos/${encodeURIComponent(videoId)}/archive-reason`, { reason });
    return result;
  }

  async function remove(videoId, reason) {
    return api.delete(`/api/admin/videos/${encodeURIComponent(videoId)}`, {
      query: { reason },
      retry: false,
    });
  }

  return { list, create, get, update, setStatus, publish, archive, remove };
}
