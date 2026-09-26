/* GET /api/media/preview — 控制端试听 (M07).

   The audio for one video's subtitle review, so an operator can hear the line
   they are correcting. Small on purpose: it is the only audio route, and it
   answers one question ("give me this video's audio") rather than taking a
   time range.

   ## Why it takes no start/end

   The original call site asked for `?start=&end=` and played the result with
   `new Audio(url)`. That cannot work well in a browser. An <audio> element
   fetches a whole resource and seeks within it; the only in-resource way to
   express a range is the media fragment `#t=`, which is imprecise on a
   byte-range-less response (the browser must buffer from the start to seek) and
   unsupported for offsets on some engines. Mean-ingful preview needs the whole
   audio element and a `currentTime` seek, which is a client-side operation.

   So this route serves the video's audio derivative whole, with byte-range
   support, and the page seeks. One download serves every sentence in the
   review session — the alternative, a per-sentence extraction, would mean an
   ffmpeg call on every click and a much larger surface for no benefit.

   ## Why this is admin-authenticated, not ticket-authenticated

   The sibling catch-all ([[path]].js) deliberately ignores the caller's session
   and trusts only a signed ticket, so a leaked playlist leaks one video rather
   than an account. That is right for playback and wrong for review: an operator
   reviews subtitles while the video is still a draft, and
   `POST /api/media/ticket` refuses anything that is not PUBLISHED and processed
   (403 NOT_PUBLISHED, 409 NOT_PROCESSED). Gating this route on a ticket would
   make the review screen unusable for exactly the videos that need reviewing.

   Admin-equivalent auth is therefore required, and the route lives as a static
   sibling of the catch-all so Pages Functions gives it the request before
   [[path]].js — which would otherwise reject it for a missing ticket. */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { createClient, requireAdmin } from '../../_lib/supabase.js';
import { normalizePrefix } from '../../_lib/media-ticket.js';

/** Where the pipeline is expected to leave the audio derivative, beside the
    media under the video's playback prefix. Ordered by preference: m4a first
    because it is what the pipeline is documented to emit, the others so a
    video processed before that convention existed still previews. */
const AUDIO_CANDIDATES = ['audio.m4a', 'audio.aac', 'audio.mp3'];

const AUDIO_TYPES = {
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
};

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const url = new URL(request.url);

    const videoId = url.searchParams.get('video_id') || url.searchParams.get('videoId');
    if (!videoId) throw new HttpError(400, 'VIDEO_ID_REQUIRED', '缺少视频 ID');

    const client = createClient(env);
    const rows = await client.select('videos',
      `select=id,playback_prefix&id=eq.${encodeURIComponent(videoId)}&limit=1`);
    const video = rows?.[0];
    // 404 rather than 403 for an unknown id, so this route is not an id oracle
    // for a non-admin probe — the same reasoning as the plans handler.
    if (!video) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在');

    if (!video.playback_prefix) {
      // The message names the cause the operator can act on. "尚未处理" rather
      // than "音频不存在" because the audio is missing as a consequence, and the
      // button's own failure toast says the same thing.
      throw new HttpError(409, 'NOT_PROCESSED', '该视频尚未处理完成,无法试听');
    }

    const bucket = env.PROCESSING_BUCKET;
    if (!bucket) throw new HttpError(500, 'CONFIG_MISSING', '缺少 R2 绑定 PROCESSING_BUCKET');

    const prefix = normalizePrefix(video.playback_prefix);
    const object = await findAudio(bucket, prefix);
    if (!object) {
      throw new HttpError(404, 'AUDIO_NOT_FOUND', '该视频没有音频文件,请确认处理流程已生成 audio.m4a');
    }

    const extension = object.key.slice(object.key.lastIndexOf('.') + 1).toLowerCase();
    const headers = new Headers({
      'Content-Type': object.httpMetadata?.contentType || AUDIO_TYPES[extension] || 'audio/mp4',
      // Private: this is admin-only content behind a session, and a shared cache
      // holding it would be one more place it can outlive the session. Ten
      // minutes is enough that switching between sentences does not re-download.
      'Cache-Control': 'private, max-age=600',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    });
    if (object.httpEtag) headers.set('ETag', object.httpEtag);

    // Range support is not optional here. The page seeks with `currentTime`,
    // and a browser cannot seek in a media resource it has not fully buffered
    // unless the server honours ranges — without the 206 path, previewing the
    // last sentence of a long video would download everything before it.
    const range = parseRange(request.headers.get('Range'), object.size);
    if (!range) {
      headers.set('Content-Length', String(object.size));
      return new Response(object.body, { status: 200, headers });
    }

    const { start, end } = range;
    headers.set('Content-Length', String(end - start + 1));
    headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);

    return new Response(sliceStream(object.body, start, end), { status: 206, headers });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Try each candidate key in order. Absence is not an error here — the list is
    a fallback chain, and only an exhausted list means the audio is missing. */
async function findAudio(bucket, prefix) {
  for (const name of AUDIO_CANDIDATES) {
    const key = `${prefix}/${name}`;
    const object = await bucket.get(key);
    if (object) return { ...object, key };
  }
  return null;
}

/** Parse a single-range `bytes=` header. Returns null for a malformed or absent
    header and for a multi-range request, which is answered with the whole
    object instead: a media element sends a single range, and implementing
    multipart/byteranges for a case that does not occur would be complexity
    nobody exercises. A range past the end is clamped rather than refused —
    browsers do probe past EOF while seeking. */
function parseRange(header, size) {
  if (!header || !size) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    // Suffix form `bytes=-N`: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    end = Math.min(end, size - 1);
  }

  if (start >= size || start > end) return null;
  return { start, end };
}

/** Emit bytes [start, end] of `stream`, skipping the head and stopping at the
    end. R2 hands back a stream, not a random-access slice, so the bytes before
    `start` are read and discarded. One pass, one reader: an earlier version
    teed the stream and drained the head from the second branch, which read the
    object twice and raced the two branches against each other. */
function sliceStream(stream, start, end) {
  const reader = stream.getReader();
  const total = end + 1;
  let cursor = 0;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        const chunkStart = cursor;
        cursor += value.byteLength;
        if (cursor <= start) continue;                    // entirely before the window
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(value.byteLength, total - chunkStart);
        if (to > from) {
          controller.enqueue(value.subarray(from, to));
          // The window is complete: close now rather than leaving the reader
          // open on the rest of the object.
          if (cursor >= total) { controller.close(); }
          return;
        }
        // Past the window: stop reading rather than draining the whole object.
        if (cursor >= total) { controller.close(); return; }
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
}
