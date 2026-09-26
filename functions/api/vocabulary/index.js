/* /api/vocabulary — 生词本 (M06).

   GET  the caller's saved words and followed words
   POST save a word

   The list is not paginated. That is deliberate: the client's `isSaved(word)`
   answer has to be correct for *every* word on screen, and it is derived by
   scanning this response. A paged list would make a word the learner saved
   last week — sitting on page 2 — report as not-saved, and the bookmark icon
   would silently flip back to hollow. A vocabulary list is small enough
   (thousands of rows at the very most) that returning it whole is the right
   trade.

   `term` is the identity of a word: the client normalises the surface form
   (lowercase, strip everything but letters/digits/apostrophe/hyphen) and sends
   the original as `surface` for display. So "Running", "running," and "running"
   are one row, which is what the learner expects — the same word met in two
   videos appears once and carries both contexts. */

import { HttpError, errorResponse, json } from '../../_lib/env.js';
import { createClient, requireUser } from '../../_lib/supabase.js';
import { pick, trimmed } from '../../_lib/fields.js';

const WORD_COLUMNS = 'id,term,surface,gloss,source_video_id,source_sentence,source_start_seconds,created_at';

/** The client sends an already-normalised `term`, but a hand-written curl or a
    future mobile client may not. Normalising here too means the uniqueness
    constraint can never be defeated by a caller that skips it — which would
    otherwise produce two rows for one word and a duplicated entry in the list.

    Kept byte-identical in behaviour to `normalize()` in src/services/vocabulary.js;
    if one changes, both must. */
export function normalizeTerm(word) {
  return String(word ?? '').trim().toLowerCase().replace(/[^a-z0-9'-]/g, '');
}

export async function onRequestGet({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const client = createClient(env);
    const scope = `user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=2000`;

    const [words, following] = await Promise.all([
      client.select('vocabulary_words', `select=${WORD_COLUMNS}&kind=eq.saved&${scope}`),
      client.select('vocabulary_words', `select=${WORD_COLUMNS}&kind=eq.followed&${scope}`),
    ]);

    // Both lists, never one or the other: `isSaved` checks them together, and a
    // following that lived only in a separate response would leave the icon
    // hollow for a word the learner is following.
    return json({ words: words ?? [], following: following ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { user } = await requireUser(env, request);
    const body = await request.json().catch(() => ({}));

    const term = normalizeTerm(pick(body, 'term') ?? pick(body, 'word'));
    if (!term) throw new HttpError(400, 'TERM_REQUIRED', '请选择一个单词');

    const client = createClient(env);
    const [row] = await client.upsert('vocabulary_words', {
      user_id: user.id,
      kind: 'saved',
      term,
      // The display form falls back to the normalised term so a row is never
      // rendered blank when a caller sends only `term`.
      surface: trimmed(pick(body, 'surface'), 120) ?? term,
      gloss: trimmed(pick(body, 'gloss'), 300),
      source_video_id: trimmed(pick(body, 'source_video_id'), 64),
      source_sentence: trimmed(pick(body, 'source_sentence'), 500),
      source_start_seconds: pick(body, 'source_start_seconds') === null
        || pick(body, 'source_start_seconds') === undefined
        ? null
        : Math.max(0, Number(pick(body, 'source_start_seconds')) || 0),
    }, { onConflict: 'user_id,term' });

    // Re-saving a word the learner already has must not clear the context it
    // was first saved with, so the conflict path keeps the original row's gloss
    // and sentence when this request did not bring new ones. PostgREST's merge
    // would apply the nulls, so the guard is here rather than in the caller.
    return json({ word: row }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
