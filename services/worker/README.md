# Eastudy V3 media worker

`services/worker` is the missing process between local intake and learner playback. It is a long-running Python process and is intentionally not deployed to Cloudflare Pages.

## What it does

1. Scans `INTAKE_DATA/inbox/*.json` receipts written by `services.intake`.
2. Creates one `processing_jobs` row per video and marks the video `PROCESSING`.
3. Claims a waiting or expired job through `worker_claim_job`, with a database lease.
4. Runs `ffprobe`, FFmpeg HLS (540p), cover extraction, faster-whisper English ASR, and a DeepSeek-compatible JSON translation/keyword request.
5. Writes `video_subtitles`, uploads `master.m3u8`, segments, cover, and `subtitles.json` to R2.
6. Sets `videos.playback_prefix`, `pipeline_status=READY`, `status=REVIEW`, and closes the job.
7. On failure, writes `FAILED`, `error_code`, `error_message`, and leaves the receipt/source for retry.

## Install and run

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r services/worker/requirements.txt
python -m services.worker.worker
```

Apply the migrations in order before the first run:

```text
supabase/migrations/0001_init.sql     schema
supabase/migrations/0002_worker.sql   worker_claim_job (step 3 below)
```

`0002` is not optional. Without it, `claim()` falls back to a select-then-update that is correct for a single worker and progressively worse for more — see the header of that file for why.

## Configuration

Copy `.env.example` at the repo root; it lists every variable this process reads, with the ones that are secrets marked. Two things about it are worth knowing before filling it in:

**Precedence.** The admin console's AI settings page writes to the `settings` table (key `ai`), and this worker reads that first. `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` and `AI_ENABLED` below are the *fallback*, used only when that row is missing or the read fails. So a value typed into the console wins over the environment; setting these does not override the console, it only covers the console being empty. The effective source is logged once per change at startup:

```text
AI 配置来源: settings 表 (enabled=True, model=deepseek-chat)
```

`AI_ENABLED=false` — or the console toggle off — does not fail the job. The worker publishes subtitles with no translation and sets `pipeline_status=PARTIAL`, so a missing AI configuration degrades the output rather than the pipeline.

**The prompts are not here.** The AI instructions live in `prompts/prompts.json` at the repo root — one file read by both this worker (`prompts.py`) and the console (`src/admin/prompts.js`). Editing them is editing that file; neither reader contains a copy, and a test fails if one appears.

## Flags

`python -m services.worker.worker --once` runs one poll cycle and exits — a queue check that does not wait. It still requires Supabase and R2 credentials when a real job is present.

FFmpeg/ffprobe and the selected faster-whisper model must be installed on the worker host. The model is loaded with `local_files_only=True`, so it is fetched at install time and never during a job.

## Running more than one worker

Safe, and it is what `worker_claim_job` exists for: the claim is a single `for update skip locked` statement, so two workers polling at the same moment are handed different jobs rather than fighting over the same one.

Two rules:

- **Give each worker its own `WORKER_ID`.** `worker_heartbeats` is keyed on it. A duplicate id makes two processes look like one flapping one, and the admin page can no longer tell you which host is stuck.
- **Keep `WORKER_LEASE_SECONDS` above the gap between stage transitions.** `_progress` renews the lease on every stage change, so this only has to exceed the longest single stage. If a lease does expire mid-job, the second claimant takes over and the first stops at its next checkpoint with `JOB_LEASE_LOST` — duplicated work, not corrupted output, but ASR is the expensive stage to duplicate.
