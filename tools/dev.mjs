#!/usr/bin/env node
/* Eastudy V3 — local development.

   Builds once, then serves `dist/` with the real Pages runtime. Not a mock: the
   point of running the edge functions locally is to catch the things that only
   fail in the Workers runtime (a missing `nodejs_compat` flag, a Node API that
   does not exist there, a binding that is undefined), and a mock would hide
   exactly those.

   It also starts the intake service, which is the piece an operator cannot do
   without: uploads go to loopback, and without it the upload panel fails in a
   way that looks like a bug in the panel.

   Usage:
     node tools/dev.mjs                 → build, serve on :8788, start intake
     node tools/dev.mjs --no-intake     → serve only
     node tools/dev.mjs --port=8789     → different port
     node tools/dev.mjs --watch         → rebuild bundles on change */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const withIntake = !args.includes('--no-intake');
const watch = args.includes('--watch');
const portArg = args.find((arg) => arg.startsWith('--port='));
const port = portArg ? portArg.slice('--port='.length) : '8788';

const children = [];

function run(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/* `.dev.vars` is where the local secrets live (see wrangler.toml). Missing is
   not fatal — the static shell and the unauthenticated catalog work without it —
   but saying so up front beats debugging a 500 from the first signed-in request
   and only then discovering the file was never created. */
function checkDevVars() {
  const path = join(root, '.dev.vars');
  if (existsSync(path)) return true;

  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PLAYBACK_TICKET_SECRET', 'INTAKE_HANDSHAKE_SECRET'];
  console.log('');
  console.log('提示:没有找到 .dev.vars,接口会因为没有服务端密钥而返回 500。');
  console.log('新建该文件(wrangler.toml 已将其加入 .gitignore),至少包含:');
  console.log('');
  for (const name of required) console.log(`  ${name}="..."`);
  console.log('');
  return false;
}

/* The intake token is written on the service's first start. Both sides need it:
   the edge API signs a challenge with the shared secret, and the service checks
   the token file. Printing where it lives saves the operator from hunting. */
function reportIntakeToken() {
  const path = join(root, 'runtime', 'intake', 'token');
  if (!existsSync(path)) return;
  try {
    console.log(`intake 令牌:${readFileSync(path, 'utf8').trim()}`);
  } catch {
    // Not worth failing the dev server over: the token is also readable by hand.
  }
}

async function main() {
  console.log('构建中…');
  const build = run('node', [join('tools', 'build.mjs'), ...(watch ? ['--watch'] : [])]);
  if (watch) {
    // `--watch` never exits; give esbuild a moment to produce the first build
    // before the server starts reading `dist/`.
    await new Promise((done) => setTimeout(done, 1500));
  } else {
    await new Promise((done) => {
      build.on('exit', (code) => {
        if (code !== 0) shutdown(code ?? 1);
        done();
      });
    });
  }

  if (withIntake) {
    // The intake service is Python and only reachable from this machine. It is
    // started detached from the server's lifecycle on purpose: restarting the
    // dev server should not throw away an in-flight upload.
    try {
      run('python', ['-m', 'services.intake.server', '--port', '8790', '--data', './runtime/intake']);
      setTimeout(reportIntakeToken, 1200);
    } catch {
      console.log('未能启动 intake 服务(需要 Python);用 --no-intake 可跳过。');
    }
  }

  checkDevVars();

  console.log(`\n服务启动 → http://localhost:${port}`);
  console.log(`  学生端  http://localhost:${port}/`);
  console.log(`  控制端  http://localhost:${port}/admin/\n`);

  // `wrangler pages dev` reads `pages_build_output_dir` from wrangler.toml, so
  // the directory is not passed again here.
  const server = run('npx', ['wrangler', 'pages', 'dev', '--port', port]);
  server.on('exit', (code) => shutdown(code ?? 0));
}

main().catch((error) => {
  console.error(error.message);
  shutdown(1);
});
