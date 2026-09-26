/* Eastudy V3 — 版面校验台的构建 + 服务 (仅开发用)。

   把 tools/layout-harness.js 用 esbuild 打成一个包, 连同真实的 CSS 一起
   放在 F:/tmp/layout-harness/ 下, 起一个只监听回环地址的静态服务器。

   为什么要单独起服务而不是用 dist: dist 里的 app.js 会去读 env.js 里的
   Supabase 配置, 没配置就直接抛 —— 那样看不到任何版面。这个校验台绕开的
   正是那一层, 别的都走真代码。 */

import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const OUT = 'F:/tmp/layout-harness';
const PORT = 8795;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

await mkdir(OUT, { recursive: true });

await build({
  entryPoints: ['tools/layout-harness.js'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outfile: join(OUT, 'harness.js'),
  logLevel: 'warning',
});

for (const name of ['tokens.css', 'themes-12.css', 'app.css']) {
  await writeFile(join(OUT, name), await readFile(join('public/assets', name)));
}

await writeFile(join(OUT, 'index.html'), `<!doctype html>
<html lang="zh-CN" data-theme="theme-01" data-mode="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Eastudy 版面校验台</title>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="themes-12.css">
<link rel="stylesheet" href="app.css">
<style>
  /* 只加校验台自己的外框, 绝不覆盖组件样式 —— 在这里写一条覆盖, 看到的
     就不是真实版面了, 那这个台子就白搭了。 */
  body { margin: 0; }
  .harness-bar {
    position: sticky; top: 0; z-index: 500;
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 8px 10px; font: 13px/1.4 system-ui, sans-serif;
    background: #fde68a; color: #713f12; border-bottom: 1px solid #f59e0b;
  }
  .harness-bar button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid #b45309; background: #fffbeb; cursor: pointer; }
  .harness-bar code { background: #fef3c7; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<div class="harness-bar">
  <strong>版面校验台</strong>
  <span>真模块 · 假数据</span>
  <button id="btn-theme">换主题 <code id="theme-name">theme-01</code></button>
  <button id="btn-mode">深浅切换</button>
  <button id="btn-card">弹出词卡</button>
  <button id="btn-sheet">打开筛选抽屉</button>
  <button id="btn-scroll">滚到底</button>
</div>
<div id="app"></div>
<script type="module" src="harness.js"></script>
</body>
</html>
`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (name.includes('..')) { res.writeHead(403).end('nope'); return; }
  try {
    const body = await readFile(join(OUT, name));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// 只监听回环 —— 这个台子不做鉴权, 不能暴露在局域网上。
server.listen(PORT, '127.0.0.1', () => {
  console.log(`版面校验台: http://127.0.0.1:${PORT}`);
});
