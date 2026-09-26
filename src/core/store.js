/* Eastudy V3 — minimal observable state.

   Deliberately tiny: pages own their state, and only genuinely shared values
   (session, catalog, playback preferences, theme) live in a store. The legacy
   kept a single mutable global object that every module wrote to, which is why
   a stale read was the most common class of bug in it. */

export function createStore(initial = {}) {
  let state = Object.freeze({ ...initial });
  const subscribers = new Set();

  function notify(changedKeys, previous) {
    if (!subscribers.size) return;
    const payload = { state, previous, changedKeys };
    for (const entry of [...subscribers]) {
      try {
        if (entry.keys && !entry.keys.some((key) => changedKeys.includes(key))) continue;
        entry.fn(state, payload);
      } catch (error) {
        console.error('[store] 订阅者抛出异常', error);
      }
    }
  }

  function set(patch) {
    const previous = state;
    const next = typeof patch === 'function' ? patch(previous) : patch;
    if (!next) return state;

    const changedKeys = [];
    for (const [key, value] of Object.entries(next)) {
      if (!Object.is(previous[key], value)) changedKeys.push(key);
    }
    if (!changedKeys.length) return state;

    state = Object.freeze({ ...previous, ...next });
    notify(changedKeys, previous);
    return state;
  }

  function subscribe(keysOrFn, maybeFn) {
    const entry = typeof keysOrFn === 'function'
      ? { keys: null, fn: keysOrFn }
      : { keys: Array.isArray(keysOrFn) ? keysOrFn : [keysOrFn], fn: maybeFn };
    if (typeof entry.fn !== 'function') throw new TypeError('store.subscribe 需要回调函数');
    subscribers.add(entry);
    return () => subscribers.delete(entry);
  }

  /** Apply now, then on every change of `key`. Returns a disposer. */
  function bind(key, applyFn) {
    applyFn(state[key], state);
    return subscribe([key], (next) => applyFn(next[key], next));
  }

  return {
    get: (key) => (key === undefined ? state : state[key]),
    set,
    subscribe,
    bind,
    get size() { return subscribers.size; },
  };
}
