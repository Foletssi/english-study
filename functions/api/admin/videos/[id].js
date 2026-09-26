/* /api/admin/videos/:id — read, update, delete (soft).

   Updates go through optimistic concurrency: the client sends the `revision`
   it last saw, and a mismatch returns 409 with the current row so the admin UI
   can merge rather than silently clobber a colleague's edit. The legacy
   overwrote unconditionally, which is how two operators editing the same video
   lost each other's work. */

import { HttpError, errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';

const EDITABLE = {
  title: (v) => String(v).trim().slice(0, 200),
  subtitle: (v) => (v ? String(v).slice(0, 300) : null),
  description: (v) => (v ? String(v).slice(0, 4000) : null),
  category_id: (v) => v || null,
  level: (v) => v || null,
  tags: (v) => (Array.isArray(v) ? v.slice(0, 20) : []),
  speaker: (v) => v || null,
  accent: (v) => v || null,
  cover_url: (v) => v || null,
  visibility: (v) => (v === 'private' ? 'private' : 'public'),
  sort_order: (v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
};

const TRANSITIONS = {
  PUBLISHED: ['REVIEW'],
  ARCHIVED: ['PUBLISHED', 'REVIEW', 'DRAFT'],
  REVIEW: ['PROCESSING', 'DRAFT'],
  PROCESSING: ['DRAFT'],
};

export async function onRequestGet({ request, env, params }) {
  try {
    await requireAdmin(env, request);
    const id = pathId(params);
    const client = createClient(env);
    const rows = await client.select('videos', `select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    if (!rows?.length) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在');
    return json({ video: rows[0] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPatch({ request, env, params }) {
  try {
    const { user } = await requireAdmin(env, request);
    const id = pathId(params);
    const body = await request.json();
    const client = createClient(env);

    const rows = await client.select('videos', `select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    const current = rows?.[0];
    if (!current) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在');

    if (body.revision !== undefined && Number(body.revision) !== Number(current.revision)) {
      throw new HttpError(409, 'CONTENT_REVISION_CONFLICT', '该视频已被其他人修改,请刷新后重试', { video: current });
    }

    const patch = { revision: Number(current.revision || 1) + 1, updated_at: new Date().toISOString(), updated_by: user.id };
    for (const [key, coerce] of Object.entries(EDITABLE)) {
      const incoming = body[key] !== undefined ? body[key] : body[camel(key)];
      if (incoming !== undefined) patch[key] = coerce(incoming);
    }

    if (body.status !== undefined && body.status !== current.status) {
      const allowed = TRANSITIONS[body.status] || [];
      if (!allowed.includes(current.status)) {
        throw new HttpError(409, 'STATUS_TRANSITION_INVALID',
          `不能从 ${current.status} 直接变为 ${body.status}`, { from: current.status, to: body.status });
      }
      patch.status = body.status;
      if (body.status === 'PUBLISHED') {
        if (!current.playback_prefix) {
          throw new HttpError(409, 'NOT_PROCESSED', '该视频尚未完成转码,不能发布');
        }
        patch.published_at = new Date().toISOString();
        patch.published_by = user.id;
      }
    }

    const [row] = await client.update('videos', `id=eq.${encodeURIComponent(id)}&revision=eq.${current.revision}`, patch);
    if (!row) throw new HttpError(409, 'CONTENT_REVISION_CONFLICT', '保存冲突,请刷新后重试');
    return json({ video: row });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Soft delete only. Permanent removal is a separate, audited flow because it
   destroys R2 objects and the legacy rule is that media never disappears
   without a recoverable window. */
export async function onRequestDelete({ request, env, params }) {
  try {
    const { user } = await requireAdmin(env, request);
    const id = pathId(params);
    const client = createClient(env);

    const [row] = await client.update('videos',
      `id=eq.${encodeURIComponent(id)}`,
      {
        status: 'ARCHIVED',
        archived_at: new Date().toISOString(),
        archived_by: user.id,
        revision: undefined,
      });

    await client.insert('video_deletion_requests', {
      video_id: id,
      requested_by: user.id,
      mode: 'soft',
      state: 'COMPLETED',
      created_at: new Date().toISOString(),
    }).catch(() => null);

    return json({ video: row, archived: true });
  } catch (error) {
    return errorResponse(error);
  }
}

/** `params.id` from the `[id].js` filename. Was `params.path` under the previous
    `[[path]].js`; the rename matters beyond tidiness, because a catch-all also
    matches its own parent path — `/api/admin/videos` was being answered here
    instead of by ./index.js. `[id].js` and the `[id]/` directory that holds
    archive-reason.js and source-received.js coexist: the deeper explicit route
    wins, and the one-segment route cannot rival the parent list. Verified
    against `wrangler pages dev`. */
function pathId(params) {
  const raw = params?.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id) throw new HttpError(400, 'VIDEO_ID_REQUIRED', '缺少视频 ID');
  return id;
}

function camel(key) {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
