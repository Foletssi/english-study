/* POST /api/media/ticket — mint a playback ticket for one video.

   This is the only place that decides whether a learner may watch something.
   The decision is made once, here, for the whole session; the segment route
   then only checks the signature. The legacy re-checked entitlement on every
   segment request, which meant a 40-minute video made a few thousand
   Supabase round trips and one flaky query mid-playback killed the stream.

   Access rule, in order:
     1. signed in (the caller forges nothing, the token is verified upstream)
     2. the video exists and is PUBLISHED
     3. it has been processed (playback_prefix present)
     4. if vip_only, the learner's membership is current

   Request  { video_id }
   Response { ticket, expires_at, prefix, playlist_url, subtitles_url, qualities } */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { createClient, requireUser } from '../../_lib/supabase.js';
import { profileId, profileLabel } from '../../_lib/profiles.js';
import {
  RENEW_MARGIN_SECONDS, TICKET_TTL_SECONDS, normalizePrefix, playlistUrl, signTicket, subtitlesUrl, ticketClaims,
} from '../../_lib/media-ticket.js';

const VIDEO_COLUMNS = 'id,status,visibility,playback_prefix,job_id,vip_only,media_profile';

export async function onRequestPost({ request, env }) {
  try {
    const { user, token } = await requireUser(env, request);
    const body = await request.json().catch(() => ({}));

    // Accept both spellings: the client sends snake_case, but an operator
    // poking at this with curl will reach for camelCase.
    const videoId = body.video_id || body.videoId;
    if (!videoId) throw new HttpError(400, 'VIDEO_ID_REQUIRED', '缺少视频 ID');

    const client = createClient(env);
    const rows = await client.select('videos',
      `select=${VIDEO_COLUMNS}&id=eq.${encodeURIComponent(videoId)}&limit=1`);
    const video = rows?.[0];
    if (!video) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在');
    if (video.status !== 'PUBLISHED') throw new HttpError(403, 'NOT_PUBLISHED', '该视频尚未发布');
    if (!video.playback_prefix) throw new HttpError(409, 'NOT_PROCESSED', '该视频尚未完成转码');

    if (video.vip_only) {
      const profile = await client.select('profiles',
        `select=vip_expires_at&id=eq.${encodeURIComponent(user.id)}&limit=1`, { key: token });
      const expiresAt = profile?.[0]?.vip_expires_at ? new Date(profile[0].vip_expires_at).getTime() : 0;
      if (!expiresAt || expiresAt <= Date.now()) {
        throw new HttpError(403, 'VIP_REQUIRED', '该视频需要会员');
      }
    }

    const prefix = normalizePrefix(video.playback_prefix);
    const claims = ticketClaims({ subject: user.id, videoId: video.id, jobId: video.job_id, prefix });
    const ticket = await signTicket(env.PLAYBACK_TICKET_SECRET, claims);

    return json({
      ticket,
      prefix,
      expires_at: new Date(claims.exp * 1000).toISOString(),
      ttl_seconds: TICKET_TTL_SECONDS,
      renew_after_seconds: TICKET_TTL_SECONDS - RENEW_MARGIN_SECONDS,
      playlist_url: playlistUrl(prefix, ticket),
      subtitles_url: subtitlesUrl(prefix, ticket),
      // Only the balanced-540-v1 profile is produced; the list exists so the
      // player can render a quality control without hard-coding a single item.
      // The id and its label come from the shared vocabulary — the label used to
      // be the literal '540P' beside an id read from an environment variable,
      // so setting MEDIA_PROFILE to anything else produced a quality control
      // labelled 540P pointing at a different profile.
      qualities: [{ id: profileId(env), label: profileLabel(profileId(env)), default: true }],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
