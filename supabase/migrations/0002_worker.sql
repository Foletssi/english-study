-- Eastudy V3 — worker job claim function.
--
-- This file adds exactly one thing: `public.worker_claim_job`, the atomic
-- "give me the next job" primitive. It is separate from 0001 because it is the
-- only piece of the schema that is a *contract with a process not deployed
-- here* — services/worker/worker.py calls it by name and by argument names —
-- whereas 0001 was written to be derived purely from what the edge code reads
-- and writes.
--
-- Why the function has to exist, given that worker.py already has a fallback
-- that selects and updates:
--
--   The fallback (worker.py:87-93) is a `select ... limit 1` followed by a
--   conditional `update ... where id = ? and state = 'WAITING'`. That pair is
--   two round trips and therefore two transactions. Two workers polling on the
--   same second both read the same WAITING row; one update wins, the other
--   matches zero rows, and the loser returns `None` and re-polls — a correct
--   outcome reached by losing a race. The problem is not lost jobs, it is
--   *livelock*: with N workers and M jobs starting together, every worker reads
--   the same oldest row at the top of every poll, so M-1 of them wake to do
--   nothing on every cycle while jobs further down the queue are never read at
--   all. At N=1 the fallback is fine. The point of this function is that N is
--   not fixed.
--
--   `for update skip locked` inverts that: instead of everyone fighting over
--   row one, each caller is handed a different row and nobody waits.
--
-- Apply with:  supabase db push
--        or:  psql "$DATABASE_URL" -f supabase/migrations/0002_worker.sql
--
-- Depends on 0001 (processing_jobs, job_events). Safe to re-apply:
-- `create or replace` on the function, `if not exists` on the index.

begin;

-- ---------------------------------------------------------------------------
-- worker_claim_job
-- ---------------------------------------------------------------------------

-- Signature is fixed by the caller and must not drift:
--
--   services/worker/worker.py:82
--     self.db.rpc("worker_claim_job",
--                 {"p_worker_id": self.config.worker_id,
--                  "p_lease_seconds": self.config.lease_seconds})
--
-- PostgREST resolves RPC arguments by name, so renaming either parameter
-- breaks the worker with a 404 (PGRST202 "function not found" — the same
-- response a genuinely missing function gives). worker.py treats 404 and 400
-- as "old database, use the unlocked path" rather than as an error, so a
-- rename would not raise anywhere: the worker would silently drop back to the
-- two-transaction race above and the only symptom would be that adding workers
-- stops helping.
--
-- Returns a table rather than `setof public.processing_jobs`, for a reason
-- that is not stylistic: when a PL/pgSQL function returns `setof <table>`,
-- every column of that table becomes an implicit variable in scope for the
-- whole body, and an unqualified `lease_until` or `state` in an UPDATE then
-- resolves to the variable rather than to the column. That failure is silent
-- in exactly the wrong direction — `set lease_until = v_lease_until` would be
-- read as a self-assignment of a defaulted variable. The explicit RETURN TABLE
-- list also keeps this function from ever handing out a column it was not
-- asked to hand out, which matters for a function the anon key is denied by
-- grant alone.
--
-- The column list is what worker.py actually reads off a claimed job:
--   `process(job)`  → job["id"], job["video_id"]
--   `fail(job)`     → job.get("progress")
--   `claim()`       → result.get("lease_until")
-- Nothing else is touched, so nothing else is returned. A column added here
-- later is a change to a cross-language contract; a column added to the table
-- is not.
create or replace function public.worker_claim_job(
  p_worker_id     text,
  p_lease_seconds integer
)
returns table (
  id           uuid,
  video_id     uuid,
  state        text,
  progress     integer,
  lease_until  timestamptz
)
language plpgsql
-- Volatility is the default (volatile): this function writes, so it must not be
-- planned as stable or immutable.
as $$
declare
  -- Clamp the lease before it reaches the row. worker.py sends 300
  -- (WORKER_LEASE_SECONDS, config.py:41) and these bounds are deliberately wide,
  -- because the two ends fail differently and neither should be reachable from
  -- a typo:
  --
  --   Floor 30s. A very short lease expires while the worker is still mid-stage,
  --   so a second worker claims the job out from under it. Nothing is
  --   corrupted — `_fence()` does not match and the first worker raises
  --   JOB_LEASE_LOST at its next checkpoint (worker.py:261) — but the stage is
  --   duplicated, and ASR is the expensive one. `_progress` renews on every
  --   stage transition, so 30s is far below the real renewal interval: a floor
  --   against nonsense, not a tuning knob.
  --
  --   Ceiling 1h. Too long is worse than too short. If the worker host dies
  --   mid-job the row sits in RUNNING until the lease expires and nothing —
  --   not the admin UI, not the retry endpoint — will claim it before then.
  --   isStalled() in src/admin/pages/jobs.js flags it; a flag is not recovery.
  --
  -- coalesce covers a caller that omits the argument or sends JSON null.
  -- Without it both great() and least() return NULL, and the job would be
  -- claimed with lease_until NULL — which is the "not leased" sentinel, i.e.
  -- the one value that makes the job immediately reclaimable by anyone.
  v_lease_secs  integer := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));
  v_lease_until timestamptz := now() + make_interval(secs => v_lease_secs);
  v_job         public.processing_jobs%rowtype;
  v_was_expired boolean := false;
  v_detail      text;
begin
  ---------------------------------------------------------------------------
  -- 1. Pick a job. Locked, and skipped if another caller holds it.
  ---------------------------------------------------------------------------
  --
  -- `for update skip locked` is the whole mechanism, and it is one statement:
  -- the select locks the first matching row and, if a concurrent transaction
  -- already holds that lock, skips to the next instead of blocking. So the
  -- second caller is handed row two rather than waiting for row one and then
  -- finding it taken. `limit 1` is what keeps it a hand-out rather than a
  -- queue-wide lock — without it the locking clause applies to every matching
  -- row and `skip locked` becomes a fan-out instead of a pick.
  --
  -- `order by next_run_at, created_at` is the only scheduler in the system.
  -- Nothing else reads next_run_at for control (functions/api/admin/jobs/
  -- index.js selects it for display; [id].js writes it on an operator retry),
  -- so a row whose next_run_at is in the future is a job waiting out a
  -- backoff and must not be handed out early. `is null` counts as due
  -- immediately, which is what `ensure_jobs` relies on when it inserts a row
  -- without the column.
  --
  -- The second branch is lease recovery and it is not optional. Without it, a
  -- worker that is killed (SIGKILL, container eviction, host reboot) leaves
  -- state='RUNNING' with a future lease_until and the job is stuck forever:
  -- nothing in this system ever moves a RUNNING row back to WAITING, and this
  -- function is the only reaper there is.
  --
  -- Reclaiming an expired lease is safe *because* of `_fence`: every later
  -- write from the original holder is filtered on state = 'RUNNING' and on the
  -- exact lease_until string it was last given (worker.py:269-274), so a
  -- displaced worker matches nothing, raises JOB_LEASE_LOST and stops at its
  -- next checkpoint instead of writing over the new holder's output. That
  -- `eq.` comparison is also why two claims must never produce the same
  -- timestamp for one job — they cannot: a claim only succeeds on a row whose
  -- previous lease has already expired, and now() has moved since.
  --
  -- A RUNNING row with lease_until NULL is treated as expired too. It should
  -- not be reachable — the edge retry path clears the lease and sets
  -- state='WAITING' in one statement, and so does this function — but if it
  -- ever happens (an operator PATCH, a partially applied update) the
  -- alternative is a permanently stuck job, and no path legitimately leaves a
  -- RUNNING row unleased.
  select j.*
  into v_job
  from public.processing_jobs j
  where (
          j.state = 'WAITING'
          and (j.next_run_at is null or j.next_run_at <= now())
        )
     or (
          j.state = 'RUNNING'
          and (j.lease_until is null or j.lease_until < now())
        )
  order by j.next_run_at asc nulls first, j.created_at asc
  limit 1
  for update skip locked;

  if not found then
    -- Nothing to do. An empty result is the correct answer, not an error: the
    -- worker calls this on every poll and `claim()` returns None on it, which
    -- is what makes an idle loop cheap. Raising here would turn a quiet queue
    -- into a log full of failures.
    return;
  end if;

  v_was_expired := (v_job.state = 'RUNNING');

  ---------------------------------------------------------------------------
  -- 2. Mark it ours.
  ---------------------------------------------------------------------------
  --
  -- Every column reference below is qualified (`p.lease_until`), and so are
  -- the ones in the recovery check further down. The output columns declared in
  -- `returns table` are also variables in this body, so an unqualified
  -- `lease_until` on the right-hand side of an assignment is ambiguous at
  -- best and a self-assignment at worst. Qualifying is the whole fix.
  --
  -- The update re-asserts the claimable condition rather than trusting the
  -- select above. `skip locked` prevents two callers from picking the same row
  -- *concurrently*; it does not prevent a row from changing between this
  -- function's two statements by some other writer (an operator PATCH, the
  -- admin retry endpoint). Re-checking costs one predicate and closes that gap
  -- honestly instead of assuming it away.
  --
  -- `attempt` increments on every claim, including a recovery claim. It is the
  -- number an operator reads to decide a job is in a crash loop, so counting
  -- only first-time claims would hide exactly the case they are looking for.
  -- `automatic_recovery_count` is deliberately not touched: the edge retry
  -- endpoint increments it ([id].js:47) and it means "an operator asked for
  -- this", which is a different question.
  --
  -- progress and the error fields reset because the job is restarting from
  -- PROBE. Left alone, a recovered job would show the previous attempt's
  -- progress bar and previous attempt's error message in the admin table while
  -- running, which reads as "it failed again" on a job that is healthy. This
  -- mirrors the edge retry path ([id].js:40-53) so both routes into a re-run
  -- leave the row in the same shape.
  --
  -- stage = 'QUEUED', not 'PROBE': process() sets PROBE itself at the top, and
  -- QUEUED is the truth between the claim and that first write. 0001 leaves
  -- `stage` unconstrained for the same reason — the worker is its writer and
  -- its value set is not visible from the edge.
  update public.processing_jobs p
  set
    p.state         = 'RUNNING',
    p.stage         = 'QUEUED',
    p.progress      = 0,
    p.lease_until   = v_lease_until,
    p.attempt       = p.attempt + 1,
    p.error_code    = null,
    p.error_message = null,
    p.updated_at    = now()
  where p.id = v_job.id
    and p.state in ('WAITING', 'RUNNING')
  returning p.id, p.video_id, p.state, p.progress, p.lease_until
  into v_job.id, v_job.video_id, v_job.state, v_job.progress, v_job.lease_until;

  if not found then
    -- Lost it between the lock and here. Same answer as an empty queue: the
    -- worker polls again. Not an error — it is the expected result of a
    -- legitimate race, and raising would make the fallback path look healthier
    -- than this one.
    return;
  end if;

  ---------------------------------------------------------------------------
  -- 3. Record the recovery, when there was one.
  ---------------------------------------------------------------------------
  --
  -- job_events is the operator-facing history. A first claim is uninteresting —
  -- the row's own attempt and created_at already say it — but a *recovered*
  -- claim is the only evidence that a worker died before finishing, and nothing
  -- else in the system can write it: the new worker is starting fresh and does
  -- not know the previous holder existed. Without this row, a job reclaimed
  -- four times looks identical to one that was simply retried four times.
  --
  -- actor is NULL by design: 0001 declares it `references auth.users (id)` and
  -- there is no user here. The kinds the edge writes ('MANUAL_RETRY',
  -- 'MANUAL_CANCEL') both have one; this is the system's own. `detail` carries
  -- the two facts that are otherwise lost — when the dead lease expired, and
  -- which worker took over — so the row is readable without cross-referencing
  -- worker_heartbeats.
  if v_was_expired then
    v_detail := format(
      '上一租约于 %s 过期, 由 %s 接管',
      to_char(v_job.lease_until - make_interval(secs => v_lease_secs), 'YYYY-MM-DD HH24:MI:SS'),
      coalesce(nullif(p_worker_id, ''), 'unknown-worker')
    );
    insert into public.job_events (job_id, video_id, kind, actor, detail)
    values (v_job.id, v_job.video_id, 'LEASE_RECOVERED', null, v_detail);
  end if;

  ---------------------------------------------------------------------------
  -- 4. Hand it back.
  ---------------------------------------------------------------------------
  --
  -- Re-read the row so the caller gets the values as committed rather than the
  -- ones this function assembled: `attempt`, `updated_at` and `stage` were
  -- written by the update in step 2 and are not in scope here. The re-read is
  -- inside the same transaction, which still holds the row lock, so nothing can
  -- have changed it in between.
  return query
    select p.id, p.video_id, p.state, p.progress, p.lease_until
    from public.processing_jobs p
    where p.id = v_job.id;
end;
$$;

-- Only the service role may claim. The anon key ships in the browser bundle by
-- design (public/env.js), and this function hands out RUNNING rows with lease
-- ownership — a client holding that key could call it and mark any waiting job
-- as running.
--
-- `revoke ... from public` is not redundant with the grant: PostgreSQL grants
-- EXECUTE on a new function to PUBLIC implicitly, so without the revoke the
-- grant below would add nothing and every role with schema access could call
-- it. 0001 has no GRANT statements at all — RLS is its only access control —
-- but RLS does not apply to function execution, so this is the one place in
-- the schema where a privilege statement is load-bearing.
revoke all on function public.worker_claim_job(text, integer) from public;
revoke all on function public.worker_claim_job(text, integer) from anon;
revoke all on function public.worker_claim_job(text, integer) from authenticated;
grant execute on function public.worker_claim_job(text, integer) to service_role;

-- No `security definer`. The caller is the worker's service key, which already
-- bypasses RLS, so definer would change nothing about what this can reach — and
-- it would introduce a failure this codebase is careful to avoid elsewhere: a
-- definer function runs as its owner, so if the owner is not the service role
-- the UPDATE is subject to RLS and fails only in the environment where the
-- migration was applied by a different role. Invoker semantics make the
-- caller's own privileges the whole story, and the grant above is that story.
--
-- search_path is not pinned, for the same reason plus one more: the body is
-- fully schema-qualified (`public.processing_jobs`, `public.job_events`), so
-- there is nothing for a shadowed search_path to capture. handle_new_user in
-- 0001 pins it because it is a definer function fired by a trigger on
-- auth.users; this one is invoked directly by a single known caller.

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------

-- Serves the claim's predicate and ordering — the hottest query in the system,
-- run by every polling worker every few seconds.
--
-- Partial on the two claimable states. A queue that has been running a while is
-- mostly SUCCEEDED and FAILED rows, and this function never reads those, so
-- excluding them keeps the index proportional to the backlog rather than to
-- everything ever processed.
--
-- `next_run_at` leads because the claim orders by it first; `created_at`
-- follows to break ties in the same order the query asks for. 0001's
-- `processing_jobs_state_idx` on (state) is left alone — it still serves the
-- admin list's `state=eq.` filter, and dropping an index another query uses in
-- order to speed up this one is not a trade to make blind.
create index if not exists processing_jobs_claim_idx
  on public.processing_jobs (next_run_at asc nulls first, created_at asc)
  where state in ('WAITING', 'RUNNING');

commit;
