/* Eastudy V3 — playback tickets.

   The media route never sees the learner's Supabase token. The client trades
   that token for a short-lived signed ticket scoped to one video's prefix, and
   the ticket is what travels in the playlist and segment URLs. A leaked
   playlist therefore leaks one video for six hours, not an account. */

import { EVENTS, emit } from '../core/bus.js';

const RENEW_MARGIN_MS = 10 * 60 * 1000;

export function createMediaService({ api }) {
  const tickets = new Map();     // videoId → { ticket, expiresAt, playlistUrl }

  async function ticket(videoId) {
    const cached = tickets.get(videoId);
    if (cached && cached.expiresAt - Date.now() > RENEW_MARGIN_MS) return cached;

    const result = await api.post('/api/media/ticket', { video_id: videoId });
    const entry = {
      ticket: result.ticket,
      expiresAt: new Date(result.expires_at).getTime(),
      playlistUrl: result.playlist_url,
      subtitlesUrl: result.subtitles_url || null,
      qualities: result.qualities || [],
    };
    tickets.set(videoId, entry);
    emit(EVENTS.CATALOG_CHANGED, { reason: 'ticket', videoId });
    return entry;
  }

  async function subtitles(videoId) {
    const entry = await ticket(videoId);
    if (entry.subtitlesUrl) {
      const response = await fetch(entry.subtitlesUrl, { credentials: 'omit' });
      if (response.ok) return response.json();
    }
    const result = await api.get(`/api/media/subtitles/${encodeURIComponent(videoId)}`);
    return result;
  }

  /* 试听音频 by video id, cached as a blob URL.

     The review page needs the audio for one video and then plays many different
     sentence windows inside it, so the expensive part — downloading the file —
     must happen once. A blob URL is what makes that work: an <audio> element
     can seek freely inside a fully-loaded blob, whereas pointing it at the API
     URL directly would re-request the file for every sentence and could not
     carry the bearer token at all (an <audio> src is fetched by the browser,
     not by our client, so our Authorization header never reaches the server).

     The URL is object-URL-scoped to the document, so it is revoked when it is
     replaced or on invalidate(). Leaking these pins the whole audio file in
     memory for the life of the tab. */
  const previews = new Map();    // videoId → { url, blob, fetchedAt }

  async function preview(videoId) {
    const cached = previews.get(videoId);
    if (cached) return cached;

    // `call`, not `request`: createApi exposes the former. `request` is the
    // transport function in core/http.js and is not on the api object, so this
    // threw "api.request is not a function" before reaching the network.
    const response = await api.call(`/api/media/preview?video_id=${encodeURIComponent(videoId)}`, {
      parse: 'none',
      // A whole audio derivative, over a link that may be slow: the default
      // 30s is a JSON-request budget, not a download budget.
      timeoutMs: 120_000,
    });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const entry = { url, blob, fetchedAt: Date.now() };
    previews.set(videoId, entry);
    return entry;
  }

  function invalidate(videoId = null) {
    if (videoId) {
      tickets.delete(videoId);
      const previewEntry = previews.get(videoId);
      if (previewEntry) {
        URL.revokeObjectURL(previewEntry.url);
        previews.delete(videoId);
      }
      return;
    }
    tickets.clear();
    for (const entry of previews.values()) URL.revokeObjectURL(entry.url);
    previews.clear();
  }

  return { ticket, subtitles, preview, invalidate };
}
