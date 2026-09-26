/* Eastudy V3 — hashing worker.

   Runs off the main thread so the upload UI keeps painting while a 2 GB file
   is digested. Prefers the platform's native SHA-256 (crypto.subtle), which is
   typically several times faster than the pure-JS implementation the legacy
   shipped in vendor/sha256-0.11.1.js; that JS build is kept only as a fallback
   for very large files where reading the whole buffer at once is unwise.

   Messages:
     in   {id, type:'file', file, mode:'native'|'stream'}   whole file
     in   {id, type:'buffer', buffer}                       one chunk
     out  {id, type:'progress', loaded, total}
     out  {id, type:'done', digest}
     out  {id, type:'error', error}
*/

const READ_SIZE = 8 * 1024 * 1024;
const NATIVE_LIMIT = 512 * 1024 * 1024;

let jsHasher = null;
function loadJsHasher() {
  if (jsHasher) return jsHasher;
  importScripts(new URL('../vendor/sha256.js', self.location.href).href);
  jsHasher = self.EastudySha256;
  if (!jsHasher) throw new Error('sha256 回退实现未加载');
  return jsHasher;
}

async function digestBuffer(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashFile(id, file) {
  if (file.size <= NATIVE_LIMIT) {
    const buffer = await file.arrayBuffer();
    self.postMessage({ id, type: 'progress', loaded: file.size * 0.9, total: file.size });
    const digest = await digestBuffer(buffer);
    return digest;
  }
  // Large file: stream in bounded reads through the JS implementation so a
  // 2 GB file never needs a 2 GB ArrayBuffer.
  const hasher = loadJsHasher().create();
  let loaded = 0;
  let lastReport = 0;
  for (let offset = 0; offset < file.size; offset += READ_SIZE) {
    const block = await file.slice(offset, Math.min(file.size, offset + READ_SIZE)).arrayBuffer();
    hasher.update(block);
    loaded += block.byteLength;
    const now = Date.now();
    if (now - lastReport > 200) {
      lastReport = now;
      self.postMessage({ id, type: 'progress', loaded, total: file.size });
    }
  }
  return hasher.hex();
}

self.onmessage = async (event) => {
  const { id, type, file, buffer } = event.data || {};
  try {
    let digest;
    if (type === 'file') digest = await hashFile(id, file);
    else if (type === 'buffer') digest = await digestBuffer(buffer);
    else throw new Error(`未知的哈希任务类型：${type}`);
    self.postMessage({ id, type: 'done', digest });
  } catch (error) {
    self.postMessage({ id, type: 'error', error: error?.message || String(error) });
  }
};
