/* GET/PUT /api/admin/settings — 系统设置 (M10).

   Operator-tunable knobs: the playback profile, upload concurrency, and how
   long source files are retained. Deliberately a small, named set rather than a
   free-form key/value bag. The legacy stored settings as arbitrary JSON and the
   admin page wrote whatever the form happened to contain, which meant a renamed
   input silently created a second key beside the old one and the worker kept
   reading the stale value. Here the allowed keys are a list, and an unknown key
   in a PUT is a 400 rather than a new row nobody reads.

   Defaults live in this file, not only in the database. A settings table that
   has never been written returns nothing, and a page that renders
   `undefined` for 播放规格 shows an empty select — so a missing row has to
   resolve to the same defaults the form's placeholder shows. */

import { HttpError, errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';
import { pick, clampInt } from '../../../_lib/fields.js';
import { DEFAULT_PROFILE, MEDIA_PROFILES, normalizeProfile } from '../../../_lib/profiles.js';

/** The single source of truth for each setting: its default, and how a value
    arriving from the client is coerced. `coerce` returning undefined means the
    input was rejected outright. */
const SCHEMA = {
  media_profile: {
    // The default is the profile the encoder actually produces, not the
    // resolution the legacy form happened to show first. See _lib/profiles.js:
    // this list used to be a resolution table that no video ever matched.
    default: DEFAULT_PROFILE,
    allowed: MEDIA_PROFILES,
    coerce: normalizeProfile,
  },
  upload_max_concurrency: {
    default: 6,
    coerce(value) {
      // Bounded at both ends: 0 would stall every upload queue, and a value
      // in the hundreds would open as many parallel uploads as the operator's
      // machine has sockets and make the intake service the bottleneck.
      return clampInt(value, 1, 32, undefined);
    },
  },
  source_retention_days: {
    default: 7,
    coerce(value) {
      return clampInt(value, 1, 365, undefined);
    },
  },
};

function defaults() {
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) out[key] = spec.default;
  return out;
}

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(env, request);
    const client = createClient(env);

    // One row per key, or a single row with a JSON body — both are tolerated,
    // because the schema is small enough that insisting on one shape would be
    // an argument about nothing. Only the keys this file declares are read out,
    // so an unrelated row in the table cannot reach the client.
    const rows = await client.select('settings', 'select=key,value&limit=500').catch(() => []);
    const stored = {};
    for (const row of rows ?? []) {
      const spec = SCHEMA[row.key];
      if (!spec) continue;
      const coerced = spec.coerce(row.value);
      if (coerced !== undefined) stored[row.key] = coerced;
    }

    return json({ settings: { ...defaults(), ...stored } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPut({ request, env }) {
  try {
    await requireAdmin(env, request);
    const body = await request.json().catch(() => ({}));

    const accepted = {};
    const rejected = [];
    for (const [key, spec] of Object.entries(SCHEMA)) {
      const raw = pick(body, key);
      if (raw === undefined) continue;
      const value = spec.coerce(raw);
      // A rejected value is an error, not a silent skip. Saving the other two
      // fields while quietly dropping the third is how an operator comes to
      // believe they changed something they did not.
      if (value === undefined) rejected.push(key);
      else accepted[key] = value;
    }

    if (rejected.length) {
      throw new HttpError(400, 'SETTING_INVALID', `设置值不合法:${rejected.join('、')}`);
    }

    const keys = Object.keys(accepted);
    if (keys.length) {
      const client = createClient(env);
      const now = new Date().toISOString();
      await client.upsert('settings', keys.map((key) => ({
        key,
        // Stored as a string because `value` is one column for settings of
        // several types; the coercion above is what makes reading it back
        // typed, so nothing downstream has to parse.
        value: String(accepted[key]),
        updated_at: now,
      })), { onConflict: 'key' });

      const rows = await client.select('settings', `select=key,value&key=in.(${keys.join(',')})&limit=100`);
      const stored = {};
      for (const row of rows ?? []) {
        const spec = SCHEMA[row.key];
        const coerced = spec?.coerce(row.value);
        if (coerced !== undefined) stored[row.key] = coerced;
      }
      return json({ settings: { ...defaults(), ...stored } });
    }

    // An empty PUT is a no-op that still reports the current state, so a client
    // that saves a form without changing anything gets a usable response rather
    // than an empty object it would have to merge itself.
    return onRequestGet({ request, env });
  } catch (error) {
    return errorResponse(error);
  }
}
