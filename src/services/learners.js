/* Eastudy V3 — learners, VIP and invite codes (M09). */

import { EVENTS, emit } from '../core/bus.js';

export function createLearnersService({ api }) {
  async function list({ page = 1, pageSize = 20, q = '', vip = '', inviteCode = '' } = {}) {
    return api.get('/api/admin/learners', { query: { page, pageSize, q, vip, inviteCode } });
  }

  async function get(userId) {
    return api.get(`/api/admin/learners/${encodeURIComponent(userId)}`);
  }

  async function setVip(userId, { enabled, expiresAt = null, note = '' }) {
    const result = await api.post(`/api/admin/learners/${encodeURIComponent(userId)}/vip`, {
      enabled, expires_at: expiresAt, note,
    }, { retry: false });
    emit(EVENTS.AUTH_CHANGED, { reason: 'vip', userId });
    return result;
  }

  async function inviteCodes({ page = 1, pageSize = 20, status = '' } = {}) {
    return api.get('/api/admin/invite-codes', { query: { page, pageSize, status } });
  }

  async function createInviteCodes({ count = 1, maxUses = 1, expiresAt = null, note = '' }) {
    const result = await api.post('/api/admin/invite-codes', {
      count, max_uses: maxUses, expires_at: expiresAt, note,
    }, { retry: false });
    return result;
  }

  async function revokeInviteCode(code) {
    return api.delete(`/api/admin/invite-codes/${encodeURIComponent(code)}`, { retry: false });
  }

  function exportCsv(rows) {
    const header = ['邀请码', '状态', '已用次数', '上限', '过期时间', '备注'];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push([
        row.code,
        row.status || '',
        row.used_count ?? 0,
        row.max_uses ?? 1,
        row.expires_at || '',
        (row.note || '').replace(/[",\n]/g, ' '),
      ].join(','));
    }
    return lines.join('\n');
  }

  return { list, get, setVip, inviteCodes, createInviteCodes, revokeInviteCode, exportCsv };
}
