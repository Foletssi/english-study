/* GET /api/media/* — signed playback and subtitle delivery.

   Two rules carried over verbatim from the legacy module contract, because
   both were learned the hard way:

   1. The playback ticket binds subject, video, prefix and expiry. A ticket
      minted for video A must not fetch video B's segments, so the prefix is
      inside the signature rather than a parameter a caller could swap.
   2. This route never reads the Supabase access token from a cookie. The
      ticket travels in the URL and the cookie is ignored entirely, so a
      cross-site request carrying an ambient session cannot pull paid media.

   Routes under this catch-all:
     /api/media/subtitles/:prefix   the cue list, JSON
     /api/media/:prefix/*.m3u8      a playlist, with relative URLs rewritten
     /api/media/:prefix/*           a segment, streamed from R2

   Ticket minting lives in ./ticket.js — a static sibling route, which Cloudflare
   Pages Functions prefers over this catch-all. */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { assertInScope, normalizePrefix, verifyTicket } from '../../_lib/media-ticket.js';

const SEGMENT_CACHE_SECONDS = 60 * 30;
const PLAYLIST_CACHE_SECONDS = 5;

export async function onRequestGet({ request, env, params }) {
  try {
    const url = new URL(request.url);
    const path = [].concat(params?.path ?? []).map((part) => decodeURIComponent(part)).join('/');
    if (!path) throw new HttpError(400, 'MEDIA_PATH_REQUIRED', '缺少媒体路径');

    const ticket = url.searchParams.get('ticket');
    if (!ticket) throw new HttpError(401, 'TICKET_REQUIRED', '缺少播放凭证');
    const claims = await verifyTicket(env.PLAYBACK_TICKET_SECRET, ticket);

    const bucket = env.PROCESSING_BUCKET;
    if (!bucket) throw new HttpError(500, 'CONFIG_MISSING', '缺少 R2 绑定 PROCESSING_BUCKET');

    // Subtitles are addressed by prefix, not by object key, so they are not
    // in scope of the segment check below.
    if (path.startsWith('subtitles/')) {
      const prefix = normalizePrefix(path.slice('subtitles/'.length));
      assertInScope(claims, prefix);
      return await serveSubtitles(bucket, prefix);
    }

    assertInScope(claims, path);
    return await serveObject(bucket, path, ticket);
  } catch (error) {
    return errorResponse(error);
  }
}

/** The cue list the player renders. Stored beside the media under the video's
    prefix, so a re-process replaces both together and they cannot drift. */
async function serveSubtitles(bucket, prefix) {
  const candidates = [`${prefix}/subtitles.json`, `${prefix}/subtitle.json`, `${prefix}/captions.json`];
  for (const key of candidates) {
    const object = await bucket.get(key);
    if (!object) continue;
    const text = await object.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(502, 'SUBTITLES_MALFORMED', '字幕文件格式不正确');
    }
    const cues = Array.isArray(parsed) ? parsed : (parsed.cues ?? parsed.sentences ?? []);
    return json({ prefix, cues: normalizeCues(cues) }, {
      headers: { 'Cache-Control': `private, max-age=${SEGMENT_CACHE_SECONDS}` },
    });
  }
  throw new HttpError(404, 'SUBTITLES_NOT_FOUND', '该视频暂无字幕');
}

/** Cue shape is part of the player contract: start/end in seconds, English
    text, Chinese translation, and the token list the player renders word by
    word. Anything already in that shape passes through untouched.

    `tokens` is what the player reads (src/ui/player.js) and every token is a
    clickable word, so a cue arriving without one renders as a single
    unclickable block. The worker emits `tokens`; this file exists because
    stored subtitles are not always from the current worker, and a video
    processed by an older one is still playable.

    Two older shapes are accepted, and they need different work:

      - `words: [{ text, meaning }]` — the first worker's output. Renaming is
        enough, but the fields it lacks (key / level) are not optional: without
        them `sentence.tokens.filter(t => t.key)` is always 0 and no word is
        highlighted, so a cue from that era would look like it had no key
        words at all rather than like it was old. `meaning` becomes `gloss`
        so the word card has something to show.

      - a cue with neither field at all — the player still gets one token for
        the whole sentence, which is what it renders for a cue it cannot
        segment. Doing it here rather than in the player keeps the player's
        fallback for genuinely empty data. */
function normalizeCues(cues) {
  return (Array.isArray(cues) ? cues : []).map((cue, index) => ({
    index: Number.isFinite(cue.index) ? cue.index : index,
    start: Number(cue.start ?? cue.start_seconds ?? 0),
    end: Number(cue.end ?? cue.end_seconds ?? 0),
    text: String(cue.text ?? cue.en ?? ''),
    translation: cue.translation ?? cue.zh ?? null,
    tokens: normalizeTokens(cue),
  }));
}

function normalizeTokens(cue) {
  if (Array.isArray(cue.tokens)) return cue.tokens;
  if (Array.isArray(cue.words)) return cue.words.map(legacyToken);
  const text = String(cue.text ?? cue.en ?? '');
  return text ? [{ text }] : [];
}

/** A `words` entry from the first worker, in the shape the player reads.

    `key` is set from the mere presence of a `meaning`: that version only
    emitted a word when it had something to say about it, so a word with a
    gloss is exactly the set it considered teachable. Not setting it would
    leave the counter at 0 for every old video, which reads as "this video
    has no key words" instead of "this video predates the counter". */
function legacyToken(word) {
  return {
    text: String(word.text ?? word.word ?? ''),
    key: Boolean(word.meaning || word.gloss),
    level: 1,
    gloss: word.meaning ?? word.gloss ?? null,
    phonetic: word.phonetic ?? null,
    tag: word.tag ?? word.pos ?? null,
  };
}

async function serveObject(bucket, key, ticket) {
  const object = await bucket.get(key);
  if (!object) throw new HttpError(404, 'MEDIA_NOT_FOUND', '媒体文件不存在');

  const isPlaylist = key.endsWith('.m3u8');
  const headers = new Headers({
    'Content-Type': isPlaylist
      ? 'application/vnd.apple.mpegurl'
      : (object.httpMetadata?.contentType || 'video/mp2t'),
    'Cache-Control': `private, max-age=${isPlaylist ? PLAYLIST_CACHE_SECONDS : SEGMENT_CACHE_SECONDS}`,
    'Accept-Ranges': isPlaylist ? 'none' : 'bytes',
    'X-Content-Type-Options': 'nosniff',
  });
  if (object.httpEtag) headers.set('ETag', object.httpEtag);

  if (!isPlaylist) return new Response(object.body, { headers });

  // hls.js resolves relative playlist URLs against the page origin, which is
  // the site, not this route. Rewrite every URI line so the segment requests
  // come back here carrying the ticket.
  const text = await object.text();
  const base = key.slice(0, key.lastIndexOf('/') + 1);
  const rewritten = text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const target = trimmed.startsWith('http')
      ? new URL(trimmed).pathname.replace(/^\/api\/media\//, '')
      : new URL(trimmed, `https://local/${base}`).pathname.replace(/^\//, '');
    return `/api/media/${target}?ticket=${encodeURIComponent(ticket)}`;
  }).join('\n');

  return new Response(rewritten, { headers });
}
