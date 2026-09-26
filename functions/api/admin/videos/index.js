/* /api/admin/videos — 视频 CRUD.

   GET   list, filtered + paged
   POST  create a draft

   This is the admin side of the student↔admin mapping: every field the student
   catalog reads is written here, and the select list below is the contract
   between them. If a student screen needs a new field, it must be added here
   and to the catalog projection in the same change. */

import { HttpError, errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';
import { listResponse, readPaging, readTotal } from '../../../_lib/paging.js';

const ADMIN_COLUMNS = [
  'id', 'title', 'subtitle', 'description', 'category_id', 'level',
  'duration_seconds', 'cover_url', 'status', 'pipeline_status',
  'visibility', 'sort_order', 'tags', 'speaker', 'accent',
  'published_at', 'created_at', 'updated_at', 'revision',
  'source_sha256', 'video_url', 'playback_prefix', 'job_id',
].join(',');

const STATUSES = new Set(['DRAFT', 'PROCESSING', 'REVIEW', 'PUBLISHED', 'ARCHIVED']);

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('q');
    const category = url.searchParams.get('category');
    const { page, pageSize, offset } = readPaging(url, { defaultPageSize: 20 });

    if (status && !STATUSES.has(status)) {
      throw new HttpError(400, 'STATUS_INVALID', `状态 ${status} 不是合法值`);
    }

    const filters = [`select=${ADMIN_COLUMNS}`, 'order=updated_at.desc', `limit=${pageSize}`, `offset=${offset}`];
    if (status) filters.push(`status=eq.${status}`);
    if (category) filters.push(`category_id=eq.${encodeURIComponent(category)}`);
    if (search) {
      // PostgREST OR syntax: title or subtitle contains the term.
      const term = encodeURIComponent(`*${search}*`);
      filters.push(`or=(title.ilike.${term},subtitle.ilike.${term})`);
    }

    const client = createClient(env);
    // The total is what makes the pager appear: `createListController` compares
    // it against the page size, so a list endpoint that omits it renders no
    // pager at all and every page request looks like page 1. The count was
    // already being asked for here; nothing was reading it.
    const response = await client.call(`videos?${filters.join('&')}`, {
      headers: { Prefer: 'count=exact' },
    });
    const rows = Array.isArray(response) ? response : [];
    return listResponse({ rows, total: readTotal(response, rows), page, pageSize });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { user } = await requireAdmin(env, request);
    const body = await request.json();

    const title = String(body.title || '').trim();
    if (!title) throw new HttpError(400, 'TITLE_REQUIRED', '请填写视频标题');
    if (title.length > 200) throw new HttpError(400, 'TITLE_TOO_LONG', '标题不能超过 200 字');

    const client = createClient(env);
    const [row] = await client.insert('videos', {
      title,
      subtitle: body.subtitle ? String(body.subtitle).slice(0, 300) : null,
      description: body.description ? String(body.description).slice(0, 4000) : null,
      category_id: body.categoryId || body.category_id || null,
      level: body.level || null,
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 20) : [],
      speaker: body.speaker || null,
      accent: body.accent || null,
      cover_url: body.coverUrl || null,
      status: 'DRAFT',
      pipeline_status: 'WAITING',
      visibility: body.visibility || 'public',
      created_by: user.id,
      revision: 1,
    });

    return json({ video: row }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
