/* Eastudy V3 — playback profile vocabulary.

   A "profile" names one encoding ladder, and there is exactly one of them in
   production: `balanced-540-v1`. The local encoder produces that and nothing
   else, so every id in this file has to be something the encoder can actually
   emit.

   This file exists because the id used to be spelled three different ways in
   three places and none of them agreed:

     - `functions/api/admin/settings/index.js` accepted `360p`…`2160p`, a
       resolution vocabulary the encoder never used, and defaulted to `1080p`.
     - the settings page offered `balanced-540-v1`, the real profile id.
     - `functions/api/media/ticket.js` signed against `MEDIA_PROFILE` with a
       `balanced-540-v1` fallback.

   So an operator who picked the only option the form showed got a 400, and an
   operator who somehow saved `1080p` got a row describing a ladder nothing
   produces. The two are one vocabulary — the profile id — and this is it.

   Deliberately *not* a resolution list: `540p` is the height the profile
   happens to have, not its name, and naming it after the height is what invited
   the second vocabulary in the first place. A profile can be re-encoded at a
   different height without changing its id, which is exactly why `-v1` is in
   there. */

/** The profile every deployment produces. Used as the fallback by both the
    settings defaults and the media ticket, so a project whose `settings` table
    has never been written and whose `MEDIA_PROFILE` is unset still agrees with
    itself. */
export const DEFAULT_PROFILE = 'balanced-540-v1';

/** Every profile id the encoder can emit. Adding a member here is only half the
    change — `services/worker` has to be taught to produce it, or the admin page
    will offer a profile that no video ever carries. */
export const MEDIA_PROFILES = ['balanced-540-v1'];

/** The profile this deployment signs against.

    `MEDIA_PROFILE` is an operator override for a deployment whose encoder was
    built with a different ladder. It is narrowed through `normalizeProfile`
    rather than trusted, so a typo in the environment variable falls back to the
    default instead of minting tickets that name a profile nothing produces. */
export function profileId(env) {
  return normalizeProfile(env?.MEDIA_PROFILE) ?? DEFAULT_PROFILE;
}

/** Human label for a profile id, for the quality control in the player. */
export function profileLabel(profile) {
  const match = /-(\d{3,4})(?:-|$)/.exec(String(profile ?? ''));
  return match ? `${match[1]}P` : '默认';
}

/** Narrow an arbitrary stored value to a profile this deployment can serve.
    Returns `undefined` for anything else, which is what the settings endpoint
    treats as "reject this value" — an unrecognised profile should be a 400, not
    a silently stored string that the player then asks the CDN for.

    Deliberately no legacy-resolution mapping. A first draft accepted a bare
    `540p` by matching it against the profile ids, which would have been the
    wrong kindness twice over: it re-admits the resolution vocabulary this file
    exists to delete, and every resolution it could have accepted — 360p, 720p,
    1080p — maps onto an encoding ladder that no deployment produces, so
    accepting one stores a profile the CDN has no files for.

    A stored row left over from that vocabulary therefore reads as unrecognised
    and is skipped by the settings GET, which falls back to the default. The bad
    value heals itself on first read rather than needing a data migration. */
export function normalizeProfile(value) {
  const profile = typeof value === 'string' ? value.trim() : '';
  return MEDIA_PROFILES.includes(profile) ? profile : undefined;
}
