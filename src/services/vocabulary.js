/* Eastudy V3 — 生词本 and 关注 (M06).

   Two lists that share one table shape. A word is unique per learner per
   normalised surface form, so the same word met in two videos appears once and
   carries both contexts. */

import { EVENTS, emit } from '../core/bus.js';

function normalize(word) {
  return String(word || '').trim().toLowerCase().replace(/[^a-z0-9'-]/g, '');
}

export function createVocabularyService({ api }) {
  let cache = null;

  async function load() {
    const result = await api.get('/api/vocabulary');
    cache = result;
    emit(EVENTS.PROGRESS_CHANGED, { reason: 'vocabulary' });
    return result;
  }

  async function add({ word, gloss, videoId, sentence, startSeconds }) {
    const term = normalize(word);
    if (!term) return null;
    const result = await api.post('/api/vocabulary', {
      term,
      surface: String(word).trim(),
      gloss: gloss || null,
      source_video_id: videoId || null,
      source_sentence: sentence || null,
      source_start_seconds: Number.isFinite(startSeconds) ? startSeconds : null,
    });
    cache = null;
    emit(EVENTS.PROGRESS_CHANGED, { reason: 'vocabulary:add', term });
    return result;
  }

  async function follow({ word, videoId, sentence, startSeconds }) {
    const term = normalize(word);
    if (!term) return null;
    return api.post('/api/vocabulary/follow', {
      term,
      surface: String(word).trim(),
      source_video_id: videoId || null,
      source_sentence: sentence || null,
      source_start_seconds: Number.isFinite(startSeconds) ? startSeconds : null,
    });
  }

  async function remove(wordId) {
    const result = await api.delete(`/api/vocabulary/${encodeURIComponent(wordId)}`);
    cache = null;
    return result;
  }

  function isSaved(word) {
    const term = normalize(word);
    if (!cache) return false;
    return (cache.words ?? []).some((row) => row.term === term)
      || (cache.following ?? []).some((row) => row.term === term);
  }

  return { load, add, follow, remove, isSaved, get data() { return cache; }, normalize };
}
