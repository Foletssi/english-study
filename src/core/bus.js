/* Eastudy V3 — application event bus.

   The legacy cross-module communication was a mix of six ad-hoc browser
   events (`hashchange`, `zospeak:content-changed`,
   `eastudy:processing-content-updated`, `eastudy:studio-job-updated`,
   `eastudy:studio-sync`, `storage`) plus direct calls into globals. Nothing
   declared who listened to what, so a change in one module broke another
   silently. V3 declares every cross-module signal once, here. */

const listeners = new Map();

export const EVENTS = Object.freeze({
  AUTH_CHANGED: 'auth:changed',
  CATALOG_CHANGED: 'catalog:changed',
  PROGRESS_CHANGED: 'progress:changed',
  JOB_CHANGED: 'job:changed',
  UPLOAD_CHANGED: 'upload:changed',
  THEME_CHANGED: 'theme:changed',
  TOAST: 'ui:toast',
  ROUTE_CHANGED: 'route:changed',
  ONLINE_CHANGED: 'net:online',
});

export function on(event, handler) {
  if (typeof handler !== 'function') throw new TypeError('bus.on 需要回调函数');
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(handler);
  return () => off(event, handler);
}

export function once(event, handler) {
  const off1 = on(event, (payload) => { off1(); handler(payload); });
  return off1;
}

export function off(event, handler) {
  const set = listeners.get(event);
  if (!set) return;
  set.delete(handler);
  if (!set.size) listeners.delete(event);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set?.size) return;
  // Copy first: a handler is allowed to unsubscribe during dispatch.
  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (error) {
      // One broken listener must not stop the others, and must not reject the
      // promise chain that emitted the event.
      console.error(`[bus] ${event} 的监听器抛出异常`, error);
    }
  }
}

export function reset() {
  listeners.clear();
}

export function listenerCount(event) {
  return listeners.get(event)?.size ?? 0;
}
