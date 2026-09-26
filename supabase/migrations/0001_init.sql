-- Eastudy V3 — initial schema.
--
-- This file is derived from what the code actually reads and writes, not from a
-- design document: every column here appears in a PostgREST select list, filter
-- or payload somewhere under functions/ or src/. Columns that nothing touches
-- are not invented.
--
-- Three rules held while writing it, each of which cost something to learn:
--
--   1. No CHECK constraint on a column whose only writer lives outside this
--      repo. `processing_jobs.stage` and `worker_heartbeats.status` are written
--      by the Cloudflare worker; this codebase only ever selects them, so no
--      value set can be verified from here and a constraint would be a guess
--      that locks production out. Constrained and unconstrained columns are
--      marked below.
--
--   2. RLS is enabled on every table, with policies only where a client reaches
--      the table directly. Nearly everything goes through the edge API with the
--      service role, which bypasses RLS — so enabling it costs nothing there and
--      closes the anon-key path. `profiles` is the exception that matters: two
--      endpoints (`/api/profile`, and the VIP check in `/api/media/ticket`) pass
--      the caller's own JWT, making the policy the ownership check.
--
--   3. Every unique constraint is one the code depends on for a specific
--      upsert or race, and each is commented with the call site. A unique index
--      that nothing relies on is a future 23505 in production.
--
-- Apply with:  supabase db push
--        or:  psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql

begin;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- `updated_at` is set by the handlers, not by a trigger. The edge code writes it
-- explicitly on every mutation (because a PostgREST upsert that omitted it would
-- leave it stale), so a trigger here would be a second writer racing the first.
-- No `set_updated_at()` function, deliberately.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id                     uuid primary key references auth.users (id) on delete cascade,
  display_name           text,
  phone                  text,
  -- Constrained: 'admin' and 'learner' are the only literals in the repo
  -- (requireAdmin in functions/_lib/supabase.js; role=eq.learner throughout
  -- the admin pages).
  role                   text not null default 'learner' check (role in ('admin', 'learner')),
  vip_expires_at         timestamptz,
  avatar_url             text,
  invited_by_code        text,
  -- Read by functions/api/admin/session.js and src/services/auth.js, written by
  -- nothing. Kept as a real column rather than dropped because those two call
  -- sites read it, and a select naming a missing column is a PGRST 42703, not a
  -- null. It will stay NULL until something writes it; revisit then.
  membership_expires_at  timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);

-- A row must exist for every auth user: the edge API reads `profiles` for the
-- caller's role and membership on every authenticated request, and treats a
-- missing row as a learner with no membership. Creating it at signup keeps the
-- two tables in step without the client having to remember to insert.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, phone, display_name)
  values (
    new.id,
    new.phone,
    coalesce(new.raw_user_meta_data ->> 'display_name', null)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------

-- Never written by any handler — only read (`select=id,name,sort_order` in
-- functions/api/catalog.js). The rows are seeded at the bottom of this file.
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create unique index if not exists categories_name_key on public.categories (name);

-- ---------------------------------------------------------------------------
-- videos
-- ---------------------------------------------------------------------------

create table if not exists public.videos (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  subtitle            text,
  description         text,
  category_id         uuid references public.categories (id) on delete set null,
  level               text,
  duration_seconds    int,
  -- An external URL posted by the operator as `body.coverUrl` — not a Storage
  -- path. Supabase Storage is not used anywhere in this project.
  cover_url           text,
  -- Constrained: CONTENT_STATUS in src/ui/status.js, and the same set is
  -- re-declared at functions/api/admin/videos/index.js. The transition graph
  -- lives in code (TRANSITIONS in admin/videos/[[path]].js), not here — a CHECK
  -- can say which states exist, not which moves are legal.
  status              text not null default 'DRAFT'
                        check (status in ('DRAFT', 'PROCESSING', 'REVIEW', 'PUBLISHED', 'ARCHIVED')),
  -- Unconstrained: the worker moves this between states, and the edge only ever
  -- asserts the two literals below. Left as text so a new pipeline state does
  -- not need a migration in lockstep with a deploy.
  pipeline_status     text default 'WAITING',
  -- Constrained to the one literal the repo writes.
  visibility          text not null default 'public' check (visibility in ('public', 'private')),
  sort_order          int,
  tags                text[] not null default '{}',
  speaker             text,
  accent              text,
  published_at        timestamptz,
  revision            int not null default 1,
  -- Provenance of the uploaded original. These five exist in the schema so the
  -- degraded write path never fires: functions/api/admin/videos/[id]/source-received.js
  -- catches PGRST204/42703, retries with only source_sha256, and logs
  -- '缺少回执列,已降级写入'. Same for archive_reason below.
  source_sha256       text,
  source_bytes        bigint,
  source_name         text,
  source_received_at  timestamptz,
  source_received_by  uuid references auth.users (id) on delete set null,
  archive_reason      text,
  archived_at         timestamptz,
  archived_by         uuid references auth.users (id) on delete set null,
  -- Selected in ADMIN_COLUMNS, written by nothing. Kept for the legacy rows the
  -- operator intends to import; drop it once that import is done.
  video_url           text,
  -- R2 key prefix. NULL means "not processed" and is what blocks playback
  -- (409 NOT_PROCESSED in functions/api/media/ticket.js).
  playback_prefix     text,
  job_id              uuid,
  vip_only            boolean not null default false,
  media_profile       text,
  created_by          uuid references auth.users (id) on delete set null,
  updated_by          uuid references auth.users (id) on delete set null,
  published_by        uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- The catalog's ORDER BY. A cursor-less keyset page on a large table without
-- this is a sort of the whole table per request.
create index if not exists videos_published_at_idx on public.videos (published_at desc nulls last);
-- The admin list's ORDER BY.
create index if not exists videos_updated_at_idx on public.videos (updated_at desc);
-- The catalog's filter columns (level=eq., category_id=eq., visibility=eq.public).
create index if not exists videos_level_idx on public.videos (level);
create index if not exists videos_category_idx on public.videos (category_id);
create index if not exists videos_status_idx on public.videos (status);

-- ---------------------------------------------------------------------------
-- processing_jobs
-- ---------------------------------------------------------------------------

create table if not exists public.processing_jobs (
  id                        uuid primary key default gen_random_uuid(),
  video_id                  uuid references public.videos (id) on delete cascade,
  -- Unconstrained: the worker is the writer. JOB_STATE in src/ui/status.js
  -- names WAITING/RUNNING/SUCCEEDED/FAILED/CANCELLED, and the edge writes the
  -- last two plus WAITING, but the worker's set is not visible from here.
  state                     text not null default 'WAITING',
  -- Unconstrained for the same reason: no literal value for `stage` is written
  -- anywhere in this repo, only selected.
  stage                     text,
  progress                  int not null default 0 check (progress between 0 and 100),
  -- NULL means "not leased". isStalled() in src/admin/pages/jobs.js treats
  -- lease_until < now AND state = 'RUNNING' as a dead worker.
  lease_until               timestamptz,
  next_run_at               timestamptz,
  automatic_recovery_count  int not null default 0,
  attempt                   int not null default 0,
  error_code                text,
  error_message             text,
  restarted_by              uuid references auth.users (id) on delete set null,
  restarted_at              timestamptz,
  cancelled_by              uuid references auth.users (id) on delete set null,
  cancelled_at              timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists processing_jobs_video_idx on public.processing_jobs (video_id);
create index if not exists processing_jobs_state_idx on public.processing_jobs (state);

-- `videos.job_id` points back at the newest job. Added after both tables exist
-- because the two reference each other.
alter table public.videos
  drop constraint if exists videos_job_id_fkey;
alter table public.videos
  add constraint videos_job_id_fkey
  foreign key (job_id) references public.processing_jobs (id) on delete set null;

-- ---------------------------------------------------------------------------
-- job_events
-- ---------------------------------------------------------------------------

-- The retry/cancel audit trail. Every insert into it is wrapped in
-- `.catch(() => ...)` at functions/api/admin/jobs/[[path]].js, so a missing
-- table loses the history silently rather than failing the operation — which is
-- exactly why it is worth creating.
create table if not exists public.job_events (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid references public.processing_jobs (id) on delete cascade,
  video_id    uuid references public.videos (id) on delete cascade,
  -- Unconstrained: 'MANUAL_RETRY' and 'MANUAL_CANCEL' are the only values this
  -- repo writes, but the worker writes its own state transitions here.
  kind        text not null,
  actor       uuid references auth.users (id) on delete set null,
  detail      text,
  created_at  timestamptz not null default now()
);

create index if not exists job_events_job_idx on public.job_events (job_id, created_at desc);
create index if not exists job_events_video_idx on public.job_events (video_id, created_at desc);

-- ---------------------------------------------------------------------------
-- video_subtitles
-- ---------------------------------------------------------------------------

create table if not exists public.video_subtitles (
  id          uuid primary key default gen_random_uuid(),
  -- UNIQUE, not just a foreign key: the save path reads the row, then updates
  -- with a `revision=eq.` CAS, and when the row is absent it inserts and catches
  -- 23505 (functions/api/admin/subtitles/[[path]].js). That catch only handles
  -- the race if the constraint exists to raise it; without it, two concurrent
  -- saves produce two subtitle rows for one video and the reader picks one at
  -- random.
  video_id    uuid not null unique references public.videos (id) on delete cascade,
  revision    int not null default 1,
  -- [{ index, start, end, text, translation }], max 5000 entries (MAX_SENTENCES).
  sentences   jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- learning_progress
-- ---------------------------------------------------------------------------

create table if not exists public.learning_progress (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  video_id          uuid not null references public.videos (id) on delete cascade,
  position_seconds  numeric not null default 0,
  -- [{ start, end }], unioned server-side so coverage only ever grows.
  watch_ranges      jsonb not null default '[]'::jsonb,
  coverage          numeric not null default 0 check (coverage between 0 and 1),
  completed         boolean not null default false,
  -- Written and preserved by functions/api/progress.js on every heartbeat.
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Required by the upsert's `onConflict: 'user_id,video_id'`. Without it the
  -- upsert is a plain insert and every heartbeat makes another row.
  constraint learning_progress_user_video_key unique (user_id, video_id)
);

-- The admin dashboard's "active in the last N days" query filters updated_at,
-- and orders by it.
create index if not exists learning_progress_updated_idx on public.learning_progress (updated_at desc);
create index if not exists learning_progress_user_idx on public.learning_progress (user_id);

-- ---------------------------------------------------------------------------
-- vocabulary_words
-- ---------------------------------------------------------------------------

create table if not exists public.vocabulary_words (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  -- Constrained: 'saved' (the wordbook upsert) and 'followed' (the subtitle
  -- follower) are the only two values written.
  kind                  text not null check (kind in ('saved', 'followed')),
  -- Normalised before it gets here: trimmed, lowercased, [^a-z0-9'-] stripped.
  term                  text not null,
  surface               text,
  gloss                 text,
  source_video_id       uuid references public.videos (id) on delete set null,
  source_sentence       text,
  source_start_seconds  numeric,
  created_at            timestamptz not null default now(),
  -- Required by the wordbook upsert's `onConflict: 'user_id,term'`. Note that
  -- functions/api/vocabulary/follow.js does a plain insert, not an upsert, so
  -- following the same word twice surfaces a 23505 — the constraint is what
  -- makes that a clean conflict rather than a duplicate row.
  constraint vocabulary_words_user_term_key unique (user_id, term)
);

create index if not exists vocabulary_words_user_kind_idx on public.vocabulary_words (user_id, kind);
create index if not exists vocabulary_words_created_idx on public.vocabulary_words (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- plans / plan_items
-- ---------------------------------------------------------------------------

create table if not exists public.plans (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  title        text not null,
  target_date  date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists plans_user_created_idx on public.plans (user_id, created_at desc);

create table if not exists public.plan_items (
  id         uuid primary key default gen_random_uuid(),
  plan_id    uuid not null references public.plans (id) on delete cascade,
  video_id   uuid not null references public.videos (id) on delete cascade,
  position   int not null default 0,
  -- (plan_id, video_id) rather than (plan_id, position): the write path is
  -- delete-then-insert per plan, and the UI can legitimately send the same
  -- position twice while reordering. A unique on position would reject a save
  -- the UI considers valid.
  constraint plan_items_plan_video_key unique (plan_id, video_id)
);

create index if not exists plan_items_plan_position_idx on public.plan_items (plan_id, position);

-- ---------------------------------------------------------------------------
-- invite_codes
-- ---------------------------------------------------------------------------

create table if not exists public.invite_codes (
  id            uuid primary key default gen_random_uuid(),
  -- Crockford base32 (alphabet ABCDEFGHJKLMNPQRSTUVWXYZ23456789). UNIQUE is the
  -- real guarantee against collision; the pre-flight `code=in.(...)` check in
  -- functions/api/admin/invite-codes/index.js is only a courtesy to keep the
  -- batch from failing on insert.
  code          text not null unique,
  -- Constrained to the two values that are ever *stored*. `effectiveStatus` in
  -- the admin page derives four states (revoked/expired/used/active) — those are
  -- computed from used_count, max_uses and expires_at, and must not be added
  -- here.
  status        text not null default 'active' check (status in ('active', 'revoked')),
  used_count    int not null default 0,
  max_uses      int not null default 1 check (max_uses >= 1),
  expires_at    timestamptz,
  vip_days      int not null default 0,
  note          text,
  last_used_at  timestamptz,
  last_used_by  uuid references auth.users (id) on delete set null,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists invite_codes_status_idx on public.invite_codes (status, created_at desc);

-- ---------------------------------------------------------------------------
-- video_deletion_requests
-- ---------------------------------------------------------------------------

-- Written once per soft delete and never read back. It records an already-
-- completed action, not a pending one, which is why `state` defaults to
-- COMPLETED rather than PENDING.
create table if not exists public.video_deletion_requests (
  id            uuid primary key default gen_random_uuid(),
  video_id      uuid references public.videos (id) on delete set null,
  requested_by  uuid references auth.users (id) on delete set null,
  mode          text not null default 'soft' check (mode in ('soft', 'hard')),
  state         text not null default 'COMPLETED' check (state in ('PENDING', 'COMPLETED', 'FAILED')),
  created_at    timestamptz not null default now()
);

create index if not exists video_deletion_requests_video_idx on public.video_deletion_requests (video_id);

-- ---------------------------------------------------------------------------
-- admin_audit_log
-- ---------------------------------------------------------------------------

create table if not exists public.admin_audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references auth.users (id) on delete set null,
  -- Constrained: the three literals written anywhere in the repo are
  -- 'video.archive', 'vip.grant' and 'vip.revoke'. Widen when a new action is
  -- added — a silently rejected audit row is worse than a missing one, so if
  -- this becomes a nuisance, drop the constraint rather than loosening it.
  action       text not null check (action in ('video.archive', 'vip.grant', 'vip.revoke')),
  target_type  text not null check (target_type in ('video', 'profile', 'invite_code', 'settings')),
  -- text, not uuid: it holds whichever id the target_type names.
  target_id    text,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists admin_audit_log_target_idx on public.admin_audit_log (target_type, target_id, created_at desc);
create index if not exists admin_audit_log_actor_idx on public.admin_audit_log (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  -- Upserted with `onConflict: 'key'`, so this must be the primary key.
  key         text primary key,
  -- text, not jsonb: functions/api/admin/settings/index.js writes `String(value)`
  -- for scalars and the AI page writes `JSON.stringify({...})` for its blob.
  -- Both land here, and each reader coerces its own type back.
  value       text,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- worker_heartbeats
-- ---------------------------------------------------------------------------

-- Written by the Cloudflare worker; read by functions/api/admin/settings/worker.js,
-- which returns '心跳表不可用,请确认已执行迁移' when this table is missing.
create table if not exists public.worker_heartbeats (
  worker_id       text primary key,
  -- Unconstrained: no literal value for this column is written anywhere in this
  -- repo. STALE_AFTER_MS = 120_000 is how the reader decides a worker is gone.
  status          text,
  current_job_id  uuid references public.processing_jobs (id) on delete set null,
  started_at      timestamptz,
  last_seen_at    timestamptz not null default now(),
  version         text,
  detail          jsonb
);

create index if not exists worker_heartbeats_last_seen_idx on public.worker_heartbeats (last_seen_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- The edge API uses the service role, which bypasses RLS entirely, so these
-- policies do not affect it. They exist to close the other path: the anon key
-- ships in the browser bundle by design, and without RLS that key can read every
-- table directly. Enabling RLS with no policy denies everything, and each policy
-- below re-opens exactly what a client legitimately reaches on its own.
--
-- Two endpoints do use the caller's JWT rather than the service role:
--   functions/api/profile.js        → the `profiles` policy is its ownership check
--   functions/api/media/ticket.js   → the VIP check needs `vip_expires_at` visible
-- Both read only their own row, which `auth.uid() = id` gives them.

alter table public.profiles                enable row level security;
alter table public.categories              enable row level security;
alter table public.videos                  enable row level security;
alter table public.processing_jobs         enable row level security;
alter table public.job_events              enable row level security;
alter table public.video_subtitles         enable row level security;
alter table public.learning_progress       enable row level security;
alter table public.vocabulary_words        enable row level security;
alter table public.plans                   enable row level security;
alter table public.plan_items              enable row level security;
alter table public.invite_codes            enable row level security;
alter table public.video_deletion_requests enable row level security;
alter table public.admin_audit_log         enable row level security;
alter table public.settings                enable row level security;
alter table public.worker_heartbeats       enable row level security;

-- profiles: a user sees and updates their own row. Note that the update policy
-- is not sufficient to grant admin — `role` is only ever written by the service
-- role from the admin endpoints, and a learner updating their own row cannot
-- escalate, because the API's PATCH only forwards display_name and avatar_url.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Published videos are readable by anyone, signed in or not: the catalog is
-- public and the anon key is in the bundle. Unpublished rows are visible only to
-- admins, so a DRAFT cannot be read by guessing an id.
drop policy if exists videos_select_published on public.videos;
create policy videos_select_published on public.videos
  for select using (
    status = 'PUBLISHED'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists categories_select_all on public.categories;
create policy categories_select_all on public.categories
  for select using (true);

-- Learner-owned tables: full access to one's own rows, nothing else. The edge
-- API filters by user_id in the WHERE clause as well; this is the second lock on
-- the same door, and the one that holds if a query is ever written without it.
drop policy if exists learning_progress_own on public.learning_progress;
create policy learning_progress_own on public.learning_progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists vocabulary_words_own on public.vocabulary_words;
create policy vocabulary_words_own on public.vocabulary_words
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists plans_own on public.plans;
create policy plans_own on public.plans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists plan_items_own on public.plan_items;
create policy plan_items_own on public.plan_items
  for all using (
    exists (select 1 from public.plans pl where pl.id = plan_id and pl.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.plans pl where pl.id = plan_id and pl.user_id = auth.uid())
  );

-- Everything else has RLS on and no policy: unreachable with the anon key, fully
-- reachable with the service role. processing_jobs, job_events, invite_codes,
-- admin_audit_log, settings, worker_heartbeats, video_deletion_requests and
-- video_subtitles are all server-side concerns, and a client that could read
-- invite_codes could redeem its own codes.

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

-- Categories are read but never written by any endpoint, so without these the
-- catalog's category filter renders empty on a fresh project.
insert into public.categories (name, sort_order) values
  ('日常口语', 10),
  ('商务职场', 20),
  ('新闻时事', 30),
  ('科技科普', 40),
  ('影视片段', 50),
  ('考试听力', 60)
on conflict (name) do nothing;

-- Settings defaults matching the SCHEMA in functions/api/admin/settings/index.js.
-- Written here so a fresh deploy's settings page shows the real values rather
-- than relying on the endpoint's fallback. `media_profile` matches
-- _lib/profiles.js — the profile the encoder actually produces.
insert into public.settings (key, value) values
  ('media_profile', 'balanced-540-v1'),
  ('upload_max_concurrency', '6'),
  ('source_retention_days', '7')
on conflict (key) do nothing;

commit;
