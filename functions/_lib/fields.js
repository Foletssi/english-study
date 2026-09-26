/* Eastudy V3 — request field access.

   Two naming conventions meet at this boundary. The client services send
   snake_case because it mirrors the database columns; a hand-written curl or a
   future mobile client will reach for camelCase because that is what the field
   is called in JavaScript. Rather than pick a winner and let the other one
   silently return `undefined` — which is exactly how the media ticket and
   progress endpoints broke — every handler reads through `pick`, which accepts
   both.

   `compact` exists for the same reason on the way out: Supabase's REST layer
   treats an explicit `null` as "set this column to null" and an absent key as
   "leave it alone". A patch object that carries `undefined` values serialises
   to JSON as `{}` for those keys, which reads as absent and is usually what
   the caller meant, but it is better to strip them so the intent is visible. */

/** Read the first present, non-undefined of `snake`/`camel` from a body. */
export function pick(body, snake, fallback = undefined) {
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  if (body?.[snake] !== undefined) return body[snake];
  if (body?.[camel] !== undefined) return body[camel];
  return fallback;
}

export function has(body, snake) {
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return body?.[snake] !== undefined || body?.[camel] !== undefined;
}

/** Drop keys whose value is `undefined` so the JSON body matches the intent. */
export function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function clampInt(value, min, max, fallback) {
  const n = toInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}

export function trimmed(value, max = 500) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

/** A whole-second timestamp, which is the precision the subtitle editor uses. */
export function toSeconds(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n * 1000) / 1000;
}
