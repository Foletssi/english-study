/* Verifies public/assets/vendor/sha256.js against the standard test vectors.

   This fallback exists because `crypto.subtle.digest()` is unavailable in
   exactly the situations uploads happen in: a page served over plain http on a
   LAN address is not a secure context, so `crypto.subtle` is undefined and the
   upload's content addressing has no hash. The worker path that uses it is
   therefore already the unusual one — if the fallback is also wrong, the only
   symptom is an upload that completes and a stored file whose name does not
   match its contents, discovered much later when playback 404s.

   The vectors are the published NIST/FIPS 180-4 ones plus the boundary lengths
   where the padding logic breaks if it is wrong: 55 and 56 bytes straddle the
   point where the length field no longer fits in the final block, and 64 is the
   first length that takes a whole extra block. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/** Load the vendored script the way the browser does: it is an IIFE that hangs
    `EastudySha256` off its `self` argument, so running it in a fresh context
    with a `self` object is the closest thing to loading it in a worker. */
function loadSha256() {
  const source = readFileSync(join(root, 'public', 'assets', 'vendor', 'sha256.js'), 'utf8');
  const sandbox = { self: {} };
  runInNewContext(source, sandbox);
  assert.ok(sandbox.self.EastudySha256, 'sha256.js 未挂载 self.EastudySha256');
  return sandbox.self.EastudySha256;
}

const Sha256 = loadSha256();

/** Node's own digest, as the oracle. If this and the fallback ever disagree, the
    fallback is wrong — Node's is not the one under test. */
function reference(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function bytes(length, seed = 0) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 7 + 11) & 0xff;
  return out;
}

test('标准测试向量', () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ];

  for (const [input, expected] of vectors) {
    const ascii = Uint8Array.from(input, (char) => char.charCodeAt(0));
    assert.equal(Sha256.hex(ascii), expected, `输入 ${JSON.stringify(input)} 的摘要不符`);
  }
});

test('填充边界:55 / 56 / 63 / 64 字节', () => {
  // 55 is the last length that fits its length-field in the same block; 56
  // forces a second block; 64 is one full block, which must not be padded as if
  // it were empty.
  for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const input = bytes(length);
    assert.equal(Sha256.hex(input), reference(input), `${length} 字节时摘要不符`);
  }
});

test('分块 update 与一次性 update 结果一致', () => {
  // The upload path feeds a file in chunks as it streams, so the incremental
  // API is the one actually used; a bug that only shows up across a chunk
  // boundary would never appear in the one-shot vectors above.
  const input = bytes(100_000, 3);
  const oneShot = Sha256.hex(input);

  const hasher = Sha256.create();
  for (let offset = 0; offset < input.length; offset += 4096) {
    hasher.update(input.subarray(offset, offset + 4096));
  }
  assert.equal(hasher.hex(), oneShot);

  // Ragged chunk sizes, to hit the "buffer not yet a full block" path.
  const ragged = Sha256.create();
  let offset = 0;
  for (const size of [1, 63, 64, 65, 127, 1000, 5000, 10_000]) {
    const end = Math.min(offset + size, input.length);
    if (end > offset) ragged.update(input.subarray(offset, end));
    offset = end;
  }
  if (offset < input.length) ragged.update(input.subarray(offset));
  assert.equal(ragged.hex(), oneShot);
});

test('接受 ArrayBuffer 与 Uint8Array 两种输入', () => {
  const input = bytes(300, 9);
  const expected = reference(input);
  assert.equal(Sha256.hex(input), expected);
  // A caller handing over an ArrayBuffer must not be silently misread — the
  // upload code converts a Blob to one before calling in, and `update` coerces
  // via `new Uint8Array(input)`, which reads the whole buffer.
  const copy = input.slice().buffer;
  assert.equal(Sha256.hex(copy), expected);
});

test('对同一字节范围的两种视图结果一致', () => {
  // The worker digests a slice of a buffer it already holds. There is no
  // offset/length overload — `hex(input)` is the whole API — so the caller
  // passes a subarray view, and a subarray carries its own byteOffset. If
  // `update` ever used `.buffer` instead of the view itself, this is the case
  // that would catch it.
  const input = bytes(500, 5);
  const view = input.subarray(100, 350);
  assert.equal(Sha256.hex(view), reference(input.subarray(100, 350)));
});

test('摘要为 64 位小写十六进制', () => {
  const digest = Sha256.hex(bytes(77));
  assert.match(digest, /^[0-9a-f]{64}$/);
});
