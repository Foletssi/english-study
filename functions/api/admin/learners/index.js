/* GET /api/admin/learners — 学员列表 (M09).

   The control end's view of the accounts the 学员端 creates. Three things this
   has to get right, each of which the admin page depends on:

   1. `total`. The pager under the table renders from it, and `createListController`
       compares it against `pageSize` to decide whether to show a pager at all —
       a missing total hides it, so an operator scrolling past row 20 sees a list
       that simply stops.

   2. `vip_expires_at` per row, not an `is_vip` boolean. The table renders the
       badge as `VIP 至 2026-10-03` by comparing the date itself, so the date is
       the field it needs. (The student-facing /api/profile does return `is_vip`,
       because that page only shows a badge — different consumer, different shape,
       and neither is derived twice on the client.)

   3. `invite_code`, flattened. The row's referral is stored on the profile as
       `invited_by_code`, but the column is labelled 邀请码 and reads
       `row.invite_code` — so the raw column name is renamed on the way out
       rather than leaking the storage name into the UI contract.

   The search and filter are done in PostgREST rather than in the worker: the
   table pages at 20 and there is no bound on how many learners exist, so
   filtering a fetched page client-side would search only the visible 20 rows
   and quietly report "没有匹配的学员" for someone who is on page 9. */

import { errorResponse } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';
import { readPaging, readTotal, listResponse } from '../../../_lib/paging.js';

const LEARNER_COLUMNS = 'id,display_name,phone,role,vip_expires_at,invited_by_code,created_at';

/** PostgREST `or=(...)` needs its inner commas and parens intact, and only the
    user's text escaped — encoding the whole expression would produce
    `or%3D(...)` and silently match nothing, which reads as "no results". */
function escapeLike(value) {
  return String(value).replace(/[\\%_(),]/g, (char) => `\\${char}`);
}

function isVipActive(row) {
  const expiry = row.vip_expires_at ? new Date(row.vip_expires_at).getTime() : 0;
  return Boolean(expiry && expiry > Date.now());
}

function project(row) {
  return {
    id: row.id,
    display_name: row.display_name ?? null,
    phone: row.phone ?? null,
    role: row.role ?? 'learner',
    vip_expires_at: row.vip_expires_at ?? null,
    is_vip: isVipActive(row),
    // The column the operator sees is 邀请码; `invited_by_code` is where it is
    // stored, and the admin table reads `invite_code`. Renamed here so the
    // storage name is not part of the UI contract.
    invite_code: row.invited_by_code ?? null,
    created_at: row.created_at ?? null,
  };
}

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const url = new URL(request.url);
    const { page, pageSize, offset } = readPaging(url, { defaultPageSize: 20 });

    const search = (url.searchParams.get('q') || '').trim();
    const vip = (url.searchParams.get('vip') || '').trim();
    const inviteCode = (url.searchParams.get('inviteCode') || '').trim();

    const filters = [
      `select=${LEARNER_COLUMNS}`,
      // Learners only. An admin is an account too, and listing the operators
      // among the students would make the 学员 count and the VIP column both
      // misleading.
      'role=eq.learner',
      'order=created_at.desc',
      `limit=${pageSize}`,
      `offset=${offset}`,
    ];
    if (search) {
      const term = `*${escapeLike(search)}*`;
      filters.push(`or=(display_name.ilike.${term},phone.ilike.${term})`);
    }
    if (inviteCode) filters.push(`invited_by_code=eq.${encodeURIComponent(inviteCode)}`);

    const client = createClient(env);
    const response = await client.call(`profiles?${filters.join('&')}`,
      { headers: { Prefer: 'count=exact' } });
    let rows = (Array.isArray(response) ? response : []).map(project);
    const total = readTotal(response, rows);

    // The VIP filter runs after the page is fetched, which is the one thing
    // here that cannot be pushed into PostgREST: whether a membership is still
    // valid is a comparison against now, and the expiry column has to be
    // compared against a moving timestamp. Doing it in SQL would mean a
    // `vip_expires_at=gt.<iso>` filter that the operator's "全部学员" view
    // would then have to bypass — two code paths for one column. The cost is
    // that a filtered page can come back short; `total` stays the unfiltered
    // count so the pager still walks the full list.
    if (vip === 'active') rows = rows.filter(isVipActive);
    if (vip === 'none') rows = rows.filter((row) => !isVipActive(row));

    return listResponse({ rows, total, page, pageSize });
  } catch (error) {
    return errorResponse(error);
  }
}
