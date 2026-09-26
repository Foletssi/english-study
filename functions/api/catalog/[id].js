/* GET /api/catalog/:id — 单个视频的学员端详情.

   A sibling of `./index.js`. The file is `[id].js`, not `[[path]].js`, and that
   is load-bearing: a catch-all absorbs ZERO segments too, so it would also serve
   `/api/catalog` and leave `index.js` unreachable — the public list endpoint
   would answer with a 401 from this file's `requireUser`. Measured against
   `wrangler pages dev`, not inferred; see the guard in
   tests/unit/syntax.test.mjs. `[id].js` matches exactly one segment, cannot
   rival its parent, and is the pattern `vocabulary/` already used.

   Why this exists as a separate endpoint at all: the watch page is reached by
   URL (`/watch/<id>`), which may be a bookmark, a shared link, or a stale tab
   from yesterday's session. The catalog list it came from may never have been
   loaded — the student can land here cold. So the page cannot rely on its
   catalog cache holding this video, and without this route the only options
   were an empty player or a client-side read of `videos`, which would put the
   published/visibility filter back in the browser where a mistake leaks drafts.

   The projection is identical to the list route's, deliberately: the same
   video must not look different depending on how it was reached. */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { createClient, requireUser } from '../../_lib/supabase.js';

/** Kept byte-identical to PUBLIC_COLUMNS in ./index.js. When these drift, the
    watch page shows a field the list page treats as absent — a subtitle that
    appears only after a reload is the symptom. */
const PUBLIC_COLUMNS = [
  'id', 'title', 'subtitle', 'description', 'category_id', 'level',
  'duration_seconds', 'cover_url', 'tags', 'speaker', 'accent', 'published_at',
].join(',');

/** The id from the `[id].js` filename. `params.id` is already URL-decoded by
    the runtime, and is a single segment by construction — the old pathname
    slicing had to defend against a missing element and could not tell a real
    id from the word after a `/` in some other route. */
function videoIdFrom(params) {
  const id = params?.id;
  if (!id) throw new HttpError(400, 'VIDEO_ID_REQUIRED', '缺少视频 ID');
  return Array.isArray(id) ? id[0] : id;
}

export async function onRequestGet({ request, env, params }) {
  try {
    // Signed in, because the watch page is behind the student shell and the
    // media ticket it will request from here needs a token anyway. Returning
    // the metadata anonymously would only move the 401 three lines later.
    await requireUser(env, request);
    const videoId = videoIdFrom(params);

    const client = createClient(env);
    const rows = await client.select('videos',
      `select=${PUBLIC_COLUMNS}&id=eq.${encodeURIComponent(videoId)}`
      + '&status=eq.PUBLISHED&visibility=eq.public&limit=1');
    const video = rows?.[0];

    // A draft, a private video and a nonexistent id are all 404 for the
    // student: distinguishing them would confirm that an unpublished video
    // exists, which is exactly what the PUBLISHED filter is there to hide.
    if (!video) throw new HttpError(404, 'VIDEO_NOT_FOUND', '视频不存在或尚未发布');

    return json({ video });
  } catch (error) {
    return errorResponse(error);
  }
}
