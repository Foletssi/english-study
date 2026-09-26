/* GET/PUT /api/admin/subtitles/:videoId — 字幕校对 (M07).

   The operator-facing editor for a video's cue list. Addressed by video id,
   because that is what the review page has in hand (`/admin/subtitles/<videoId>`
   is reached from the video list) and because a video has exactly one cue list,
   so an id of its own would be an id nobody ever quotes.

   ## Why the write is a compare-and-swap

   Two operators opening the same video is the normal case, not the exotic one —
   subtitles are the slow part of the pipeline and the whole point of the queue
   is that several people can work through it. So the save carries the revision
   the editor loaded, and the update only matches when the stored revision is
   still that one. If it is not, the write is refused with 409 and the page
   reloads the newer text.

   This is not a nicety: the alternative is last-write-wins, where operator B
   silently discards every fix operator A made while B was reading. Forty minutes
   of proof-reading vanishing with no error is the worst possible outcome for
   this screen, and it is invisible — the saver sees 已保存.

   ## Why the CAS lives in the UPDATE's WHERE clause

   Reading the revision and then writing it back would be the same
   read-then-write race the invite-code redemption had. The revision is bumped
   in the same statement that checks it, so a request that loses the race
   matches no row and is told so, rather than both writers succeeding and one
   editing silently reverting the other's row.

   ## Relationship to the player

   The player does not read this table — it reads `subtitles.json` beside the
   media in R2 (see functions/api/media/[[path]].js). That file is written by
   the processing step, so an edit made here changes what the operator sees until
   the video is re-rendered. That coupling is deliberate for now: the editor is
   for review and correction before publish, and the render is what makes a
   correction reach learners. */

import { HttpError, errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';
import { has, pick, toSeconds, trimmed } from '../../../_lib/fields.js';

/** A cue list longer than this is a processing fault, not a transcript. The
    guard exists because the whole list is written in one row and one request:
    a runaway ASR pass emitting a hundred thousand segments would otherwise
    produce a body neither Postgres nor the browser wants to handle. */
const MAX_SENTENCES = 5000;

function videoIdFrom(request) {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const id = segments[segments.indexOf('subtitles') + 1];
  if (!id) throw new HttpError(400, 'VIDEO_ID_REQUIRED', '缺少视频 ID');
  return decodeURIComponent(id);
}

/** Normalise one cue from either an editor row (`{index,start,end,text,translation}`)
    or a stored file cue (`{start,end,text}` — the shape serveSubtitles reads).
    Both arrive here in practice: GET re-serves what was last written, and a
    first-ever load may be seeded from the rendered artifact. */
function normalizeSentence(raw, fallbackIndex) {
  const start = toSeconds(pick(raw, 'start'), 0);
  const end = toSeconds(pick(raw, 'end'), 0);
  return {
    index: Number.isFinite(Number(pick(raw, 'index'))) ? Number(pick(raw, 'index')) : fallbackIndex,
    start,
    // Clamped up to the start rather than rejected: the editor lets an operator
    // type times freely and drag a cue's end above its start mid-edit, and a
    // 400 on save would lose the rest of their corrections over one typo they
    // can see and fix. A zero-length cue renders as a flash, not as a crash.
    end: Math.max(end, start),
    text: String(pick(raw, 'text', '') ?? '').slice(0, 2000),
    translation: trimmed(pick(raw, 'translation'), 2000),
  };
}

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const videoId = videoIdFrom(request);
    const client = createClient(env);

    const videoRows = await client.select('videos',
      `select=id,title,status,duration_seconds&id=eq.${encodeURIComponent(videoId)}&limit=1`);
    const video = videoRows?.[0];
    if (!video) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在');

    const subtitleRows = await client.select('video_subtitles',
      `select=revision,sentences,updated_at&video_id=eq.${encodeURIComponent(videoId)}&limit=1`).catch(() => []);
    const stored = subtitleRows?.[0];

    const sentences = Array.isArray(stored?.sentences)
      ? stored.sentences.map(normalizeSentence)
      // Sorted on read so a row edited by hand, or written before this route
      // existed, still renders in playback order — the editor's rows are
      // positional, and an out-of-order list would silently reassign times to
      // the wrong lines on the next save.
      .sort((a, b) => a.start - b.start)
      : [];

    return json({
      video_id: videoId,
      title: video.title ?? null,
      status: video.status ?? null,
      duration_seconds: video.duration_seconds ?? null,
      // 0 means "never edited". The editor treats it as a normal revision, so
      // the first save against a never-edited video is not a conflict.
      revision: Number(stored?.revision ?? 0),
      updated_at: stored?.updated_at ?? null,
      sentences,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPut({ request, env }) {
  try {
    await requireAdmin(env, request);
    const videoId = videoIdFrom(request);
    const body = await request.json().catch(() => ({}));

    const incoming = pick(body, 'sentences');
    if (!Array.isArray(incoming)) throw new HttpError(400, 'SENTENCES_REQUIRED', '缺少字幕内容');
    if (incoming.length > MAX_SENTENCES) {
      throw new HttpError(400, 'TOO_MANY_SENTENCES', `字幕条数超过上限(${MAX_SENTENCES})`);
    }

    const sentences = incoming.map(normalizeSentence);

    const client = createClient(env);
    const videoRows = await client.select('videos',
      `select=id,title&id=eq.${encodeURIComponent(videoId)}&limit=1`);
    if (!videoRows?.[0]) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在');

    const subtitleRows = await client.select('video_subtitles',
      `select=revision&video_id=eq.${encodeURIComponent(videoId)}&limit=1`).catch(() => []);
    const current = subtitleRows?.[0];
    const currentRevision = Number(current?.revision ?? 0);

    // The editor always sends the revision it loaded, and omitting it is
    // treated as "I claim revision 0" only because a first save on a
    // never-edited video has nothing to conflict with. So the guard is: a
    // *present, mismatched* revision is refused. Leaving the field out of a
    // request against an already-edited video is refused too — a client that
    // forgets the field must not get a silent last-write-wins, because that
    // is precisely the bug this endpoint exists to prevent.
    const sentRevision = has(body, 'revision') ? Number(pick(body, 'revision')) : null;
    const revisionStale = sentRevision === null
      ? currentRevision > 0
      : (Number.isFinite(sentRevision) && sentRevision !== currentRevision);

    if (revisionStale) {
      return json({
        error: 'REVISION_CONFLICT',
        message: '字幕已被其他人修改,请载入最新版本',
        current_revision: currentRevision,
        // The newer text travels with the 409 so the editor can reload without
        // a second round trip — the page does call load() on conflict, and
        // handing it the data it is about to ask for avoids a window where the
        // operator sees a stale conflict banner on an already-refreshed list.
        sentences: Array.isArray(current?.sentences) ? current.sentences : [],
      }, { status: 409 });
    }

    const nextRevision = currentRevision + 1;
    const updatedAt = new Date().toISOString();
    const row = {
      video_id: videoId,
      revision: nextRevision,
      sentences,
      updated_at: updatedAt,
    };

    // The conflict check is a read, so it can still lose to a request that
    // commits between it and this write. The CAS in the WHERE clause closes
    // that window for existing rows: `revision=eq.<current>` means only one of
    // two simultaneous saves can match, and the loser gets no row back.
    let written = null;
    if (current) {
      const rows = await client.update('video_subtitles',
        `video_id=eq.${encodeURIComponent(videoId)}&revision=eq.${currentRevision}`, row);
      written = rows?.[0] ?? null;
      if (!written) {
        // Lost the CAS: another save committed between the read above and this
        // update. The revision is re-read rather than guessed — reporting
        // `currentRevision + 1` would be a fabrication that happens to be right
        // only when exactly one other write landed, and a wrong revision on a
        // conflict response is worse than none, because the editor may show it.
        const latestRows = await client.select('video_subtitles',
          `select=revision,sentences&video_id=eq.${encodeURIComponent(videoId)}&limit=1`).catch(() => []);
        return json({
          error: 'REVISION_CONFLICT',
          message: '字幕已被其他人修改,请载入最新版本',
          current_revision: latestRows?.[0]?.revision ?? null,
          sentences: Array.isArray(latestRows?.[0]?.sentences) ? latestRows[0].sentences : [],
        }, { status: 409 });
      }
    } else {
      // No row yet: the insert itself is the CAS, because `video_id` is unique
      // and a duplicate key error means another operator created it first.
      try {
        const rows = await client.insert('video_subtitles', [row]);
        written = rows?.[0] ?? null;
      } catch (insertError) {
        if (String(insertError?.detail?.code || insertError?.status || '').includes('23505')
          || /duplicate key/i.test(String(insertError?.message || ''))) {
          return json({
            error: 'REVISION_CONFLICT',
            message: '字幕已被其他人修改,请载入最新版本',
            current_revision: 1,
          }, { status: 409 });
        }
        throw insertError;
      }
    }

    // Saving subtitles deliberately does not touch the video's status. Making
    // an edit advance the video through review would mean a proof-reading pass
    // could publish it, and the whole reason this screen is separate from the
    // publish control is that those two decisions belong to different people.
    return json({
      video_id: videoId,
      revision: Number(written?.revision ?? nextRevision),
      updated_at: written?.updated_at ?? updatedAt,
      sentences,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
