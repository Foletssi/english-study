/* Eastudy V3 — durable upload ledger (IndexedDB).

   The legacy persisted upload progress to localStorage under
   'eastudy:local-intake:v1:<admin>:<video>:<sha>' and stored *no per-chunk
   record*. Three consequences, all reported by users:

   - After a reload it could only say "a session exists", so the client
     re-hashed the entire file to rediscover what it had already sent.
   - localStorage caps at roughly 5 MB and throws on quota, which a chunk
     ledger would hit immediately.
   - A write interrupted mid-string left unparseable JSON and the task was
     simply lost.

   IndexedDB fixes all three: a per-chunk record, no meaningful quota, and a
   transaction so a crash cannot leave a half-written entry. Only metadata is
   stored — chunk index, hash, size — never file bytes, tickets or keys. */

const DB_NAME = 'eastudy-v3-upload';
const DB_VERSION = 1;
const STORE_CHUNKS = 'chunks';
const STORE_SESSIONS = 'sessions';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let dbPromise = null;

function hasIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

export function openDb() {
  if (!hasIndexedDb()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const store = db.createObjectStore(STORE_CHUNKS, { keyPath: 'key' });
        store.createIndex('session', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

function tx(db, stores, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    try {
      result = run(transaction);
    } catch (error) {
      try { transaction.abort(); } catch {}
      reject(error);
    }
  });
}

function wrapped(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Stable resume key. The hash is preferred when known; name+size is the
    fallback used *before* the hash exists, which is exactly why the ledger
    can answer "have I sent this before?" without reading the file. */
export function sessionKey({ adminId, videoId = null, name = '', size = 0, sha256 = null }) {
  return `${adminId}:${videoId || 'new'}:${size}:${sha256 || name}`;
}

export async function openSession(descriptor) {
  const db = await openDb();
  if (!db) return { ...descriptor, uploadedBytes: 0, confirmed: 0 };
  const existing = await loadSession(descriptor.sessionId);
  const now = Date.now();
  if (existing) {
    const merged = { ...existing, ...descriptor, updatedAt: now };
    await tx(db, [STORE_SESSIONS], 'readwrite', (t) => { t.objectStore(STORE_SESSIONS).put(merged); });
    return merged;
  }
  const created = { ...descriptor, createdAt: now, updatedAt: now, uploadedBytes: 0, confirmed: 0 };
  await tx(db, [STORE_SESSIONS], 'readwrite', (t) => { t.objectStore(STORE_SESSIONS).put(created); });
  return created;
}

export async function loadSession(sessionId) {
  const db = await openDb();
  if (!db) return null;
  return tx(db, [STORE_SESSIONS], 'readonly', (t) => wrapped(t.objectStore(STORE_SESSIONS).get(sessionId))).then((v) => v ?? null);
}

export async function saveSession(patch) {
  const db = await openDb();
  if (!db || !patch?.sessionId) return null;
  return tx(db, [STORE_SESSIONS], 'readwrite', (t) => {
    const store = t.objectStore(STORE_SESSIONS);
    const get = store.get(patch.sessionId);
    get.onsuccess = () => {
      const merged = { ...(get.result || { sessionId: patch.sessionId, createdAt: Date.now() }), ...patch, updatedAt: Date.now() };
      store.put(merged);
    };
  });
}

export async function listSessions() {
  const db = await openDb();
  if (!db) return [];
  const rows = await tx(db, [STORE_SESSIONS], 'readonly', (t) => wrapped(t.objectStore(STORE_SESSIONS).getAll()));
  return (rows || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Map<index, sha> of chunks the server has already acknowledged. */
export async function confirmedChunks(sessionId) {
  const db = await openDb();
  if (!db) return new Map();
  const rows = await tx(db, [STORE_CHUNKS], 'readonly', (t) => wrapped(t.objectStore(STORE_CHUNKS).index('session').getAll(IDBKeyRange.only(sessionId))));
  return new Map((rows || []).map((row) => [row.index, row.sha]));
}

export async function recordChunk(sessionId, index, sha, byteLength) {
  const db = await openDb();
  if (!db) return;
  await tx(db, [STORE_CHUNKS], 'readwrite', (t) => {
    t.objectStore(STORE_CHUNKS).put({ key: `${sessionId}#${index}`, sessionId, index, sha, byteLength, at: Date.now() });
  });
}

export async function recordChunks(sessionId, entries) {
  const db = await openDb();
  if (!db || !entries?.length) return;
  await tx(db, [STORE_CHUNKS], 'readwrite', (t) => {
    const store = t.objectStore(STORE_CHUNKS);
    for (const entry of entries) {
      store.put({ key: `${sessionId}#${entry.index}`, sessionId, index: entry.index, sha: entry.sha, byteLength: entry.byteLength, at: Date.now() });
    }
  });
}

export async function dropSession(sessionId) {
  const db = await openDb();
  if (!db) return;
  await tx(db, [STORE_CHUNKS, STORE_SESSIONS], 'readwrite', (t) => {
    t.objectStore(STORE_SESSIONS).delete(sessionId);
    const index = t.objectStore(STORE_CHUNKS).index('session');
    const cursor = index.openKeyCursor(IDBKeyRange.only(sessionId));
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      t.objectStore(STORE_CHUNKS).delete(entry.primaryKey);
      entry.continue();
    };
  });
}

/** Housekeeping. A clock that jumped backwards must not delete live work, so
    only sessions older than `maxAgeMs` on *both* timestamps are pruned. */
export async function pruneStale(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const db = await openDb();
  if (!db) return 0;
  const cutoff = Date.now() - maxAgeMs;
  const rows = await listSessions();
  let removed = 0;
  for (const row of rows) {
    if (row.completedAt) continue;
    const created = row.createdAt || row.updatedAt || 0;
    const updated = row.updatedAt || created;
    if (updated < cutoff && created < cutoff) {
      await dropSession(row.sessionId);
      removed++;
    }
  }
  return removed;
}

/** Rough total size of everything still in flight, for the UI's warning. */
export async function pendingSummary() {
  const rows = await listSessions();
  return rows
    .filter((row) => !row.completedAt)
    .map((row) => ({ sessionId: row.sessionId, name: row.name, size: row.size, uploadedBytes: row.uploadedBytes || 0, updatedAt: row.updatedAt }));
}
