/* POST /api/admin/videos/:id/source-received — 原片上传回执 (M07).

   The operator's upload lands on the *local* intake service, not in R2; this
   endpoint is the other half of that handshake. It records on the video row
   that the original arrived and which digest it has, so the queue and the
   worker can agree about what is on disk before any processing is claimed.

   Why the hash is the receipt and not the file name: the intake service
   re-hashes the assembled original and refuses to hand it to the worker when
   the digest disagrees with what was declared. Persisting `source_sha256` on
   the row is what lets a resumed transfer prove it is continuing the *same*
   file rather than quietly processing a different one that shares a name.

   Idempotence is a requirement here, not a nicety. This call is issued after a
   transfer that may have been interrupted and resumed hours earlier, and the
   client fires it fire-and-forget (`await api.post(...).catch(() => {})`, see
   src/admin/upload-flow.js) — so it must be safe to repeat and nothing here may
   depend on the caller reading the response. A receipt identical to the one
   already on the row short-circuits before any write; that also keeps it from
   touching `updated_at`, which would reshuffle the admin list under the
   operator's cursor for a change they did not make.

   `revision` is deliberately left alone, matching the soft-delete route. The
   admin edit dialog holds a revision and the PATCH route rejects a stale one,
   so bumping it here would 409 the operator's own open form.

   Route placement: this file sits in a `[id]` *directory* rather than in the
   `[[path]].js` catch-all beside it, because the path has two segments after
   `videos` (`:id` and `source-received`) and the catch-all — which already
   answers GET/PATCH/DELETE for `/api/admin/videos/:id` — would otherwise
   swallow the POST. Pages resolves the more specific route first; see the
   routing note in tests/contracts/route-map.js.

   Request  { source_sha256|sourceSha256, source_bytes|sourceBytes,
              source_name|sourceName }
   Response { video, alreadyReceived } */

import { HttpError, errorResponse, json } from '../../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../../_lib/supabase.js';
import { compact, pick, trimmed } from '../../../../_lib/fields.js';

const SHA256 = /^[0-9a-f]{64}$/;

export async function onRequestPost({ request, env, params }) {
  try {
    const { user } = await requireAdmin(env, request);
    const id = videoIdFrom(params, request);
    const body = await request.json().catch(() => ({}));
    const client = createClient(env);

    const rows = await client.select('videos', `select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    const video = rows?.[0];
    // 404 rather than 403 for an id that does not exist: a distinct code would
    // confirm which video ids are real, turning this route into an oracle.
    if (!video) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在');

    const receipt = normalizeReceipt(body, user.id);
    if (alreadyRecorded(video, receipt)) return json({ video, alreadyReceived: true });

    const [row] = await writeReceipt(client, id, receipt);
    return json({ video: row ?? video, alreadyReceived: false });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Read the receipt out of the body. Both spellings are accepted because the
    client sends snake_case (it mirrors the columns) while a hand-written curl
    reaches for camelCase — the mismatch that made the media ticket endpoint
    return `400 VIDEO_ID_REQUIRED` for a correctly-shaped request. */
function normalizeReceipt(body, actorId) {
  const sha = pick(body, 'source_sha256', null);
  let sourceSha256;
  if (sha !== null && sha !== undefined) {
    sourceSha256 = String(sha).trim().toLowerCase();
    // A malformed digest is worse than none: it would be stored, compared
    // against the worker's re-hash, and fail the whole job with a checksum
    // error that blames the file rather than the caller that sent it.
    if (!SHA256.test(sourceSha256)) {
      throw new HttpError(400, 'SOURCE_SHA256_INVALID', '原片校验值格式不正确,应为 64 位十六进制');
    }
  }

  const rawBytes = pick(body, 'source_bytes', null);
  let sourceBytes;
  if (rawBytes !== null && rawBytes !== undefined && rawBytes !== '') {
    const value = Number(rawBytes);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new HttpError(400, 'SOURCE_BYTES_INVALID', '原片大小不正确');
    }
    sourceBytes = value;
  }

  return compact({
    source_sha256: sourceSha256,
    source_bytes: sourceBytes,
    // 255 is the length the intake side enforces on the same name; truncating
    // here keeps a long upload name from being rejected by the database after
    // the file has already been transferred.
    source_name: trimmed(pick(body, 'source_name'), 255) ?? undefined,
    source_received_at: new Date().toISOString(),
    source_received_by: actorId,
  });
}

/** Has this exact upload already been recorded? The digest is the load-bearing
    field, so a match on it is proof the same file landed. When the caller has
    no digest to give (the engine can finish without one) the byte count and
    name stand in: identical values mean the same file. Anything less certain
    falls through to a write, because re-recording a receipt is harmless while
    treating a second, different file as already-received would leave the row
    describing bytes that are not there. */
function alreadyRecorded(video, receipt) {
  if (receipt.source_sha256) {
    return String(video.source_sha256 || '').toLowerCase() === receipt.source_sha256;
  }
  if (receipt.source_bytes === undefined && receipt.source_name === undefined) return false;
  const bytesMatch = receipt.source_bytes === undefined
    || Number(video.source_bytes) === receipt.source_bytes;
  const nameMatch = receipt.source_name === undefined
    || String(video.source_name || '') === receipt.source_name;
  return bytesMatch && nameMatch;
}

/** Write the receipt, degrading to the columns that certainly exist.

    The legacy kept the source file's name and size on its *private* local-input
    record, not on the content row, so it is not guaranteed that every
    deployment's `videos` table carries `source_bytes` / `source_name` /
    `source_received_at`. PostgREST rejects the whole patch with PGRST204 when
    one column is unknown — and since the client swallows this call's errors, a
    failed patch would mean the original silently arrives with no receipt at
    all. So a rejected patch is narrowed to the digest and the timestamp (both
    selected by the list endpoint, so both exist) and retried, and the reduction
    is logged rather than hidden. */
async function writeReceipt(client, id, receipt) {
  const scope = `id=eq.${encodeURIComponent(id)}`;
  const patch = { ...receipt, updated_at: new Date().toISOString() };
  try {
    return await client.update('videos', scope, patch);
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    console.warn('[edge] videos 缺少回执列,已降级写入', error.detail?.message || error.message);
    return await client.update('videos', scope, compact({
      source_sha256: receipt.source_sha256,
      updated_at: patch.updated_at,
    }));
  }
}

function isMissingColumn(error) {
  const code = error?.detail?.code || error?.code;
  return code === 'PGRST204' || code === '42703';
}

function videoIdFrom(params, request) {
  // A `[id]` segment arrives as `params.id`; the pathname fallback keeps this
  // route working if Pages hands the handler a catch-all array instead, which
  // is the shape the sibling `[[path]]` route receives.
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
