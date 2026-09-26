/* GET/POST /api/admin/invite-codes — 邀请码的列表与生成 (M09).

   The other half of /api/invite-codes/redeem: this is where codes come from,
   and the two have to agree about what makes a code usable. Both read the same
   `status` / `max_uses` / `expires_at` triple, and the derived status computed
   here is the same verdict the redeem handler reaches — a code listed as 可用
   in the control end must actually redeem, or the operator hands out a code
   that fails in the learner's hands.

   `status` is stored, but the table also shows an *effective* status, because
   the stored value only records what an operator did (revoked) or what a
   redemption did (exhausted). A code that quietly passed `expires_at` has a
   stored status of `active` and would render as 可用 next to a date in the
   past. So the column the operator sees is derived here. */

import { HttpError, errorResponse } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';
import { pick, trimmed, clampInt } from '../../../_lib/fields.js';
import { readPaging, readTotal, listResponse } from '../../../_lib/paging.js';

const CODE_COLUMNS = 'id,code,status,used_count,max_uses,expires_at,vip_days,note,created_at,last_used_at';

/** How many codes one request may mint. Generating is a single insert; this is
    a bound on accidental input (a slipped keystroke sending `count: 5000`) and
    on how much of the operator's clipboard one button can fill. */
const MAX_BATCH = 100;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Codes are read aloud, printed on cards and typed from screenshots, so the
    alphabet excludes I/L/O/0/1 — the pairs people mistype. Crockford's base32
    rule, applied because a mistyped character here means a support ticket
    ("兑换码无效") rather than a rejected password the learner can retry from
    memory. */
function generateCode(groups = 3, size = 4) {
  const bytes = new Uint8Array(groups * size);
  crypto.getRandomValues(bytes);
  const parts = [];
  for (let g = 0; g < groups; g += 1) {
    let part = '';
    for (let i = 0; i < size; i += 1) {
      // Modulo over 32 exactly: the alphabet is 32 characters, so every symbol
      // is equally likely. A 33- or 36-character alphabet here would bias the
      // first few letters, which is a real (if small) reduction in entropy.
      part += CODE_ALPHABET[bytes[g * size + i] % CODE_ALPHABET.length];
    }
    parts.push(part);
  }
  return parts.join('-');
}

/** The status the operator should see: what redemption would decide. */
function effectiveStatus(row, now) {
  if (row.status === 'revoked') return 'revoked';
  const expiry = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (expiry && expiry <= now) return 'expired';
  const used = Number(row.used_count ?? 0);
  const max = Number(row.max_uses ?? 1);
  if (used >= max) return 'used';
  return 'active';
}

function project(row, now) {
  return {
    ...row,
    used_count: Number(row.used_count ?? 0),
    max_uses: Number(row.max_uses ?? 1),
    // Sent alongside the raw `status` rather than replacing it: the table
    // badges on this one, while DELETE and the redeem path act on the stored
    // one, and collapsing them would make the list and the actions disagree.
    status: effectiveStatus(row, now),
    stored_status: row.status ?? 'active',
  };
}

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const url = new URL(request.url);
    const { page, pageSize, offset } = readPaging(url, { defaultPageSize: 20 });
    const wanted = (url.searchParams.get('status') || '').trim();

    const filters = [
      `select=${CODE_COLUMNS}`,
      'order=created_at.desc',
      `limit=${pageSize}`,
      `offset=${offset}`,
    ];

    // 'used' and 'expired' are derived, so they cannot be asked of the database
    // directly. Only the two that map onto stored columns are pushed down; the
    // derived ones are applied after, which is why the filter below pages
    // through the raw rows rather than the projection.
    if (wanted === 'revoked') filters.push('status=eq.revoked');

    const client = createClient(env);
    const response = await client.call(`invite_codes?${filters.join('&')}`,
      { headers: { Prefer: 'count=exact' } });
    const raw = Array.isArray(response) ? response : [];
    const total = readTotal(response, raw);
    const now = Date.now();

    let rows = raw.map((row) => project(row, now));
    if (wanted && wanted !== 'revoked') rows = rows.filter((row) => row.status === wanted);

    return listResponse({ rows, total, page, pageSize });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    await requireAdmin(env, request);
    const body = await request.json().catch(() => ({}));

    const count = clampInt(pick(body, 'count', 1), 1, MAX_BATCH, 1);
    const maxUses = clampInt(pick(body, 'max_uses', 1), 1, 10000, 1);
    const vipDays = clampInt(pick(body, 'vip_days', 30), 1, 3650, 30);

    const expiresRaw = trimmed(pick(body, 'expires_at'), 40);
    let expiresAt = null;
    if (expiresRaw) {
      const parsed = new Date(expiresRaw);
      if (Number.isNaN(parsed.getTime())) {
        throw new HttpError(400, 'EXPIRES_AT_INVALID', '过期时间格式不正确');
      }
      expiresAt = parsed.toISOString();
    }

    const note = trimmed(pick(body, 'note'), 200);
    const now = new Date().toISOString();

    const client = createClient(env);
    // Collisions are checked rather than assumed impossible. A 12-character code
    // from a 32-symbol alphabet has ample space, but the insert would fail on
    // the unique constraint and the operator would see a generic database error
    // for a condition the batch can simply retry past.
    const rows = [];
    for (let attempt = 0; attempt < 5 && rows.length < count; attempt += 1) {
      const batch = Array.from({ length: count - rows.length }, () => ({
        code: generateCode(),
        status: 'active',
        used_count: 0,
        max_uses: maxUses,
        vip_days: vipDays,
        expires_at: expiresAt,
        note,
        created_at: now,
      }));
      const existing = await client.select('invite_codes',
        `select=code&code=in.(${batch.map((row) => encodeURIComponent(row.code)).join(',')})`);
      const taken = new Set((existing ?? []).map((row) => row.code));
      rows.push(...batch.filter((row) => !taken.has(row.code)));
    }

    if (rows.length < count) {
      throw new HttpError(500, 'CODE_GENERATION_FAILED', '邀请码生成失败,请重试');
    }

    const created = await client.insert('invite_codes', rows);
    // The dialog reads `payload.codes ?? []` and tolerates bare strings, so the
    // response carries rows and the client's own fallback keeps working — but
    // the authoritative answer is the inserted rows, not the ones we built,
    // because the database is what actually holds them.
    return listResponse({ rows: created ?? rows, total: rows.length, page: 1, pageSize: rows.length });
  } catch (error) {
    return errorResponse(error);
  }
}
