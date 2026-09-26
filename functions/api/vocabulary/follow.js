/* /api/vocabulary/follow — 关注一个词 (M06).

   POST only. Following is the weaker of the two gestures: it marks a word the
   learner wants to meet again, without the gloss and sentence the 生词本
   carries. Unfollowing is the same DELETE as removing a saved word, which is
   why there is no `unfollow` route — the id is what identifies the row, not
   the kind, and two delete endpoints for one row would be two places for the
   ownership check to drift.

   This file is a static sibling of `[id].js`, so Pages routes `/api/vocabulary/follow`
   here and `/api/vocabulary/<uuid>` there. If it were folded into a `[[path]]`
   catch-all, the two would collide and `follow` would be read as an id. */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { createClient, requireUser } from '../../_lib/supabase.js';
import { pick, trimmed } from '../../_lib/fields.js';
import { normalizeTerm } from './index.js';

export async function onRequestPost({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const body = await request.json().catch(() => ({}));

    const term = normalizeTerm(pick(body, 'term') ?? pick(body, 'word'));
    if (!term) throw new HttpError(400, 'TERM_REQUIRED', '请选择一个单词');

    const client = createClient(env);

    // Following a word that is already in the 生词本 would create a second row
    // for one term and the word would appear in both lists — the icon would
    // then read as saved, but the learner would see it twice. `onConflict` is
    // scoped to (user_id, term) so this reuses the existing row and leaves its
    // `kind` alone; the saved entry wins because it holds more.
    const existing = await client.select('vocabulary_words',
      `select=id,kind&user_id=eq.${encodeURIComponent(user.id)}&term=eq.${encodeURIComponent(term)}&limit=1`);
    if (existing?.[0]) return json({ word: existing[0], alreadyKnown: true });

    const [row] = await client.insert('vocabulary_words', {
      user_id: user.id,
      kind: 'followed',
      term,
      surface: trimmed(pick(body, 'surface'), 120) ?? term,
      source_video_id: trimmed(pick(body, 'source_video_id'), 64),
      source_sentence: trimmed(pick(body, 'source_sentence'), 500),
      source_start_seconds: pick(body, 'source_start_seconds') === null
        || pick(body, 'source_start_seconds') === undefined
        ? null
        : Math.max(0, Number(pick(body, 'source_start_seconds')) || 0),
    });

    return json({ word: row }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
