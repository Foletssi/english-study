/* Eastudy V3 — 控制端入口.

   Structurally identical to the student bootstrap, with two differences that
   matter:

   1. The gate is `requireAdmin`, checked against the server on every load. The
      legacy read `role` once at login and cached it, so revoking an operator
      took effect only after they signed out.
   2. The upload engine is only instantiated inside the upload flow, so a
      dashboard visit never pays for the hashing worker. */

import { createThemeController, attachToastBridge, toast } from '../ui/index.js';
import { createRouter } from '../core/router.js';
import { EVENTS, emit, on } from '../core/bus.js';
import { readEnvironment, assertSafeEnvironment } from '../config/environment.js';
import {
  createApi, createAuthService, createCatalogService, createAdminVideosService,
  createJobsService, createLearnersService, createSystemService, describeError,
} from '../services/index.js';
import { createAdminLayout } from '../admin/layout.js';
import { createLoginPage } from '../student/pages/login.js';
import { createDashboardPage } from '../admin/pages/dashboard.js';
import { createVideosPage } from '../admin/pages/videos.js';
import { createJobsPage } from '../admin/pages/jobs.js';
import { createSubtitlesPage } from '../admin/pages/subtitles.js';
import { createLearnersPage } from '../admin/pages/learners.js';
import { createLearnerDetailPage } from '../admin/pages/learner-detail.js';
import { createSettingsPage } from '../admin/pages/settings.js';

export async function bootstrap() {
  const environment = readEnvironment();

  try {
    assertSafeEnvironment(environment);
  } catch (error) {
    document.body.replaceChildren(renderFatal(error.message));
    return;
  }

  const theme = createThemeController();
  attachToastBridge();

  const auth = createAuthService({ environment });
  const api = createApi({ getToken: () => auth.accessToken() });

  const services = {
    auth,
    api,
    catalog: createCatalogService({ api }),
    videos: createAdminVideosService({ api }),
    jobs: createJobsService({ api }),
    learners: createLearnersService({ api }),
    system: createSystemService({ api, intakeUrl: environment.intakeUrl }),
    // The subtitle review page needs the video's audio for 试听. It is built
    // here rather than inside the page so the blob URL cache survives leaving
    // and returning to the screen within one session — the audio download is
    // the expensive part, and re-fetching it on every visit would make the
    // preview button feel broken on a slow link.
    media: createMediaService({ api }),
  };

  const mountNode = document.getElementById('app');

  await auth.init();

  if (!auth.isSignedIn) {
    renderLogin();
    return;
  }

  // `requireAdmin()` resolves to `true` and throws `ADMIN_REQUIRED` when the
  // server says no — it never resolves to a record. The legacy read `.admin`
  // off that boolean, so the check was `!undefined` on every load and every
  // operator, including a real one, landed on the denial screen.
  try {
    await auth.requireAdmin();
  } catch (error) {
    renderDenied(error);
    return;
  }

  await startAdmin();

  function renderLogin() {
    const page = createLoginPage({
      auth,
      productName: 'Eastudy 控制端',
      onAuthenticated: async () => {
        try {
          await auth.requireAdmin();
        } catch (error) {
          renderDenied(error);
          return;
        }
        await startAdmin();
      },
    });
    mountNode.replaceChildren(page.root);
    page.mount();
  }

  function renderDenied(error) {
    const node = document.createElement('div');
    node.className = 'fatal';
    const title = document.createElement('h1');
    title.textContent = '没有访问权限';
    const body = document.createElement('p');
    // `ADMIN_REQUIRED` covers both "this account is not an admin" and "the
    // server refused the session"; `describeError` already turns it into a
    // sentence, so the generic branch defers to it rather than inventing a
    // second wording for the same condition.
    body.textContent = error?.code === 'ADMIN_REQUIRED'
      ? (error.message || '当前账号不是管理员。请联系管理员开通权限。')
      : describeError(error);
    const button = document.createElement('button');
    button.className = 'btn btn--ghost';
    button.type = 'button';
    button.textContent = '切换账号';
    button.addEventListener('click', async () => { await auth.signOut(); location.reload(); });
    node.append(title, body, button);
    mountNode.replaceChildren(node);
  }

  function startAdmin() {
    const layout = createAdminLayout({
      session: auth,
      theme,
      navigate: (path) => router.navigate(path),
    });

    const router = createRouter({
      container: layout.outlet,
      onNavigate: (path) => layout.setRoute(path),
      onError: (error) => emit(EVENTS.TOAST, { message: `页面加载失败:${describeError(error)}`, variant: 'error' }),
      routes: {
        '/admin': (ctx) => createDashboardPage({ ...services, navigate: ctx.navigate }),
        '/admin/videos': (ctx) => createVideosPage({ ...services, navigate: ctx.navigate, params: ctx.query }),
        '/admin/jobs': (ctx) => createJobsPage({ ...services, navigate: ctx.navigate }),
        '/admin/subtitles/:id': (ctx) => createSubtitlesPage({ ...services, navigate: ctx.navigate, params: ctx.params }),
        '/admin/learners': (ctx) => createLearnersPage({ ...services, navigate: ctx.navigate }),
        // Registered after the list route but matched by depth, not order: the
        // router compares segment counts, so `:id` cannot swallow `/admin/learners`.
        '/admin/learners/:id': (ctx) => createLearnerDetailPage({ ...services, navigate: ctx.navigate, params: ctx.params }),
        '/admin/settings': (ctx) => createSettingsPage({ ...services, navigate: ctx.navigate }),
      },
      fallback: (ctx) => ({
        root: document.createElement('div'),
        mount() { ctx.navigate('/admin'); },
        unmount() {},
      }),
    });

    mountNode.replaceChildren(layout.root);
    layout.setProfile(auth.profile);
    router.start();
  }

  on(EVENTS.AUTH_CHANGED, ({ authenticated }) => {
    if (!authenticated) location.reload();
  });

  window.addEventListener('unhandledrejection', (event) => {
    // A failed background poll should not look like a crash to the operator.
    const reason = event.reason;
    if (reason?.status === 401) return;
    toast(describeError(reason), { variant: 'error' });
  });
}

/* Same missing call as the student entry: a module body does not invoke what it
   exports, so declaring `bootstrap` left the operator staring at the boot
   screen. The listener above is registered *inside* bootstrap and therefore
   never ran either, which is why nothing surfaced in the console.

   `renderFatal` is outside the closure, so it is reachable here. The message is
   prefixed rather than bare: this path also catches the configuration guard on
   a build that shipped without its Supabase values, and that message alone
   ("环境配置有误：…") reads like a user error rather than a deployment one. */
bootstrap().catch((error) => {
  document.body.replaceChildren(renderFatal(`启动失败：${error?.message || error}`));
});

function renderFatal(message) {
  const node = document.createElement('div');
  node.className = 'fatal';
  const title = document.createElement('h1');
  title.textContent = '无法启动';
  const body = document.createElement('p');
  body.textContent = message;
  node.append(title, body);
  return node;
}
