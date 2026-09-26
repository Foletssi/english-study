/* POST /api/admin/videos/:id/archive-reason — 归档原因 (M07).

   Archiving is a status change; *why* the video was pulled is a second,
   optional fact the operator types into the 归档 dialog. The client sends the
   status change first (`PATCH /api/admin/videos/:id` with `status: 'ARCHIVED'`)
   and only then calls here, and only when a reason was actually filled in —
   see `archive()` in src/services/admin-videos.js. So this route must assume
   the row is already ARCHIVED and must never be the thing that performs the
   archive.

   Where the reason is kept: on the row, in `archive_reason`, because the admin
   list and the video detail pane both want to show it without a second query.
   The audit log gets a copy as well. The copy is not redundancy for its own
   sake — the audit log is retained when a video is later purged, which is the
   whole point of recording *why* something was removed, whereas the row it
   describes is gone by then. The log write is best-effort, the same as the
   membership note in `admin/learners/[[path]].js`: losing an audit line is bad,
   but failing the operator's request because the log table blinked is worse.

   Idempotence: this is an UPDATE, not an INSERT, and it is scoped to the id, so
   a repeat call rewrites the same value rather than creating a second record.
   When the incoming text already matches what is stored the write is skipped
   entirely — re-archiving from the UI, or a retried request, must not knock
   `updated_at` forward and reshuffle the list the operator is working in.

   `revision` is left untouched for the same reason as the sibling
   source-received route: the admin edit dialog holds a revision, and bumping
   it here would 409 the operator's own open form on their next save.

   Route placement: `[id]/archive-reason.js` rather than the `[[path]].js`
   catch-all beside it. Pages resolves the deeper, more specific file first;
   without it the catch-all — which only answers GET/PATCH/DELETE for
   `/api/admin/videos/:id` — would take the POST and 405 it.

   Request  { reason | note }
   Response { video, reason, alreadyRecorded } */

import { HttpError, errorResponse, json } from '../../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../../_lib/supabase.js';
import { compact, pick, trimmed } from '../../../../_lib/fields.js';

const REASON_MAX = 500;

export async function onRequestPost({ request, env, params }) {
  try {
    const { user } = await requireAdmin(env, request);
    const id = videoIdFrom(params, request);
    const body = await request.json().catch(() => ({}));
    // `note` is accepted as an alias because that is the field name the audit
    // log uses for the same kind of text, and a caller reaching for the audit
    // vocabulary should not have its note silently dropped.
    const reason = trimmed(pick(body, 'reason', pick(body, 'note')), REASON_MAX);
    if (!reason) throw new HttpError(400, 'REASON_REQUIRED', '缺少归档原因');

    const client = createClient(env);
    const rows = await client.select('videos', `select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    const video = rows?.[0];
    // 404 rather than 403 for an id that does not exist: a distinct code would
    // confirm which video ids are real, turning this route into an oracle.
    if (!video) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在');

    if (String(video.archive_reason || '') === reason) {
      return json({ video, reason, alreadyRecorded: true });
    }

    const [row] = await writeReason(client, id, reason);

    // Best-effort, and deliberately after the row write: the reason the operator
    // typed is already safe on the video, so a missing or unhappy audit table
    // must not turn a successful archive into an error toast.
    await client.insert('admin_audit_log', {
      actor_id: user.id,
      action: 'video.archive',
      target_type: 'video',
      target_id: id,
      note: reason,
      created_at: new Date().toISOString(),
    }).catch(() => null);

    return json({ video: row ?? video, reason, alreadyRecorded: false });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Write the reason, degrading when the column is not there yet.

    `archive_reason` is the one field this route adds, and unlike `status` /
    `archived_at` / `archived_by` — which the delete handler in the sibling
    `[[path]].js` already writes — nothing else in the codebase reads it back,
    so there is no existing code proving the column exists on every deployment's
    `videos` table. PostgREST rejects the entire patch with PGRST204 when it
    meets an unknown column, which would lose the reason completely even though
    the audit-log copy would still land. So the patch is retried without it
    rather than failing, and the drop is logged where an operator can see it.
    Once the column is migrated, this branch stops being taken. */
async function writeReason(client, id, reason) {
  const scope = `id=eq.${encodeURIComponent(id)}`;
  try {
    return await client.update('videos', scope, {
      archive_reason: reason,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    console.warn('[edge] videos 缺少 archive_reason 列,原因仅记入审计日志', error.detail?.message || error.message);
    return [];
  }
}

function isMissingColumn(error) {
  const code = error?.detail?.code || error?.code;
  return code === 'PGRST204' || code === '42703';
}

function videoIdFrom(params, request) {
  // A `[id]` directory segment arrives as `params.id`; the pathname fallback
  // keeps the route working if Pages hands the handler the catch-all array
  // shape instead, which is what the sibling `[[path]]` route receives.
  const raw = params?.id ?? segmentAfter(request, 'videos');
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id) throw new HttpError(400, 'VIDEO_ID_REQUIRED', '缺少视频 ID');
  return decodeURIComponent(String(id));
}

function segmentAfter(request, name) {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = segments.indexOf(name);
  return index === -1 ? null : segments[index + 1];
}
