/* Eastudy V3 — 学员端入口.

   Boot order matters and is deliberate:

   1. Theme first, before anything paints, so the page never flashes light on a
      dark preference.
   2. Auth second — the router needs to know whether a session exists before it
      can decide between the login screen and the app.
   3. Router last.

   There is no global mutable `window.state` object. Everything a page needs is
   passed to it, which is what makes a page testable without a browser. */

import { createThemeController, attachToastBridge, toast } from '../ui/index.js';
import { createRouter } from '../core/router.js';
import { EVENTS, emit, on } from '../core/bus.js';
import { readEnvironment, assertSafeEnvironment, apiUrl } from '../config/environment.js';
import {
  createApi, createAuthService, createCatalogService, createProgressService,
  createMediaService, createVocabularyService, describeError,
} from '../services/index.js';
import { createStudentLayout } from '../student/layout.js';
import { createLoginPage } from '../student/pages/login.js';
import { createHomePage } from '../student/pages/home.js';
import { createCatalogPage } from '../student/pages/catalog.js';
import { createWatchPage } from '../student/pages/watch.js';
import { createPlanPage } from '../student/pages/plan.js';
import { createVocabularyPage } from '../student/pages/vocabulary.js';
import { createAccountPage } from '../student/pages/account.js';

export async function bootstrap() {
  const environment = readEnvironment();

  try {
    assertSafeEnvironment(environment);
  } catch (error) {
    document.body.innerHTML = '';
    document.body.appendChild(renderFatal(error.message));
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
    progress: createProgressService({ api }),
    media: createMediaService({ api }),
    vocabulary: createVocabularyService({ api }),
  };

  const mountNode = document.getElementById('app');

  await auth.init();

  // The login screen is not a route: it is the state the app is in before
  // there is a session. Making it a route meant the legacy had to special-case
  // deep links and could render the app shell over the login form.
  if (!auth.isSignedIn) {
    renderLogin();
    return;
  }

  // The student surface has no role gate — every signed-in account may watch.
  // The legacy of the admin entry left a `requireAdmin()` call here, which the
  // student role fails, so the home page was replaced by an empty shell for
  // exactly the users it was built for.
  await startApp();

  function renderLogin() {
    const page = createLoginPage({
      auth,
      productName: 'Eastudy',
      onAuthenticated: async () => {
        await startApp();
      },
    });
    mountNode.replaceChildren(page.root);
    page.mount();
  }

  async function startApp() {
    const layout = createStudentLayout({
      session: auth,
      theme,
      navigate: (path) => router.navigate(path),
    });

    const router = createRouter({
      container: layout.outlet,
      onNavigate: (path) => {
        layout.setRoute(path);
        window.scrollTo({ top: 0, behavior: 'instant' });
      },
      onError: (error, path) => {
        emit(EVENTS.TOAST, { message: `页面加载失败:${describeError(error)}`, variant: 'error' });
        void path;
      },
      routes: {
        '/': (ctx) => createHomePage({ ...services, session: auth, navigate: ctx.navigate }),
        '/catalog': (ctx) => createCatalogPage({ ...services, session: auth, navigate: ctx.navigate, params: ctx.query }),
        '/search': (ctx) => createCatalogPage({ ...services, session: auth, navigate: ctx.navigate, params: ctx.query }),
        '/watch/:id': (ctx) => createWatchPage({ ...services, session: auth, navigate: ctx.navigate, params: ctx.params }),
        '/plan': (ctx) => createPlanPage({ ...services, session: auth, navigate: ctx.navigate }),
        '/vocabulary': (ctx) => createVocabularyPage({ ...services, session: auth, navigate: ctx.navigate, params: ctx.query }),
        '/account': (ctx) => createAccountPage({ ...services, session: auth, navigate: ctx.navigate, theme }),
      },
      fallback: (ctx) => createNotFoundPage(ctx.navigate),
    });

    mountNode.replaceChildren(layout.root);
    layout.setProfile(auth.profile);
    router.start();
  }

  // A signed-out session in another tab signs this one out too: Supabase
  // broadcasts that event, and the legacy kept rendering a logged-in shell
  // whose every request 401'd.
  on(EVENTS.AUTH_CHANGED, ({ authenticated }) => {
    if (!authenticated) location.reload();
  });

  window.addEventListener('error', (event) => {
    if (event.error?.name === 'ChunkLoadError') {
      toast('页面资源加载失败,请刷新重试。', { variant: 'error' });
    }
  });

  void apiUrl;
}

/* The module is loaded by <script type="module" src="/assets/app.js">, and a
   module body only runs its own top level — declaring `bootstrap` does not call
   it. Without this line the boot screen stayed on "正在加载…" forever, on both
   apps at once, with no error in the console: the classic silent-failure shape,
   where the entry point is correct and simply never runs.

   The catch is the second half of the fix. `bootstrap` handles its own
   configuration failure, but anything thrown outside that try — auth init, the
   first route render — would reject this promise with nobody attached, so the
   user would get the same frozen boot screen instead of a reason. */
bootstrap().catch((error) => {
  document.body.innerHTML = '';
  document.body.appendChild(renderFatal(`启动失败：${error?.message || error}`));
});

function createNotFoundPage(navigate) {
  return {
    root: (() => {
      const node = document.createElement('div');
      node.className = 'page page--notfound';
      node.innerHTML = '<h1 class="page__title">页面不存在</h1><p class="page__subtitle">链接可能已失效。</p>';
      const button = document.createElement('button');
      button.className = 'btn btn--primary';
      button.type = 'button';
      button.textContent = '回到首页';
      button.addEventListener('click', () => navigate('/'));
      node.appendChild(button);
      return node;
    })(),
    mount() {},
    unmount() {},
  };
}

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
