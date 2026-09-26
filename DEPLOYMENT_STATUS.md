# Eastudy V3 deployment status

## Cloudflare

- Pages project: `english-study`
- Latest deployment: `https://452b2bea.english-study-18v.pages.dev`
- R2 bucket: `eastudy-v3-media-hk`
- R2 location hint: `apac`
- Pages binding: `PROCESSING_BUCKET`

The old R2 bucket is not referenced by this deployment. Cloudflare Pages Functions
run on Cloudflare's global edge and do not support pinning execution to a single
Hong Kong node. The new R2 bucket uses the closest available APAC placement hint.

## Verified

- `npm run check`: 77 tests passed; build passed.
- `/env.js`: production label, Supabase URL and publishable key present; no server secret.
- `/`: HTTP 200 with CSP, `nosniff`, and referrer policy headers.
- Functions bundle and `_routes.json` uploaded successfully.
- `PLAYBACK_TICKET_SECRET`, `INTAKE_HANDSHAKE_SECRET`, `SUPABASE_URL`, and
  `SUPABASE_ANON_KEY` are configured as production Pages secrets.

## Remaining activation step

The production Pages runtime still needs the configured Supabase project's
server-only service-role key. Set it without committing it:

```powershell
npx wrangler pages secret put SUPABASE_SERVICE_ROLE_KEY --project-name english-study
npx wrangler pages deploy dist --project-name english-study --branch main --commit-message "Activate Supabase server access" --commit-dirty true
```

Then run `supabase/migrations/0001_init.sql`, `0002_worker.sql`, and
`0003_learned.sql` in order against the target Supabase project. Until those two
steps are complete, authenticated API routes intentionally return
`CONFIG_MISSING` rather than touching an unknown database.
