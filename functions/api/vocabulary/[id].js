/* /api/vocabulary/:id — 移除一个词 (M06).

   DELETE only. The client's 移除 button is rendered from a row it already has,
   so the id is always the row's `id` — but the id is taken from the path and
   the ownership filter is applied in the database, together, so a learner who
   edits the id in devtools deletes nothing rather than someone else's word.

   Deleting twice is a success, not a 404: the client fires this from a list
   that may be a heartbeat behind, and a spinner stuck on "移除中" because the
   row was already gone reads as a broken button. `deleted` says which happened
   without turning the second call into an error the toast would show. */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { createClient, requireUser } from '../../_lib/supabase.js';

function wordIdFrom(request) {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const id = segments[segments.indexOf('vocabulary') + 1];
  if (!id) throw new HttpError(400, 'WORD_ID_REQUIRED', '缺少生词 ID');
  return decodeURIComponent(id);
}

export async function onRequestDelete({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const wordId = wordIdFrom(request);
    const client = createClient(env);

    const existing = await client.select('vocabulary_words',
      `select=id,term&id=eq.${encodeURIComponent(wordId)}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!existing?.[0]) return json({ ok: true, deleted: false, id: wordId });

    // Scoped by user_id as well as id, so the delete is owned even though the
    // row was just read — the read and the write are not one transaction, and
    // RLS alone should not be the only thing standing between them.
    await client.remove('vocabulary_words',
      `id=eq.${encodeURIComponent(wordId)}&user_id=eq.${encodeURIComponent(user.id)}`);

    return json({ ok: true, deleted: true, id: wordId, term: existing[0].term });
  } catch (error) {
    return errorResponse(error);
  }
}
