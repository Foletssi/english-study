/* /api/admin/jobs/:jobId — job control.

   POST   retry      requeue a failed or stalled job
   DELETE cancel     stop a running job (fenced by the current lease)

   Recovery is the point of this endpoint. The legacy had automatic recovery
   counting in the worker but no operator-facing way to kick a job that had run
   out of automatic attempts, so a stuck video stayed stuck until someone
   edited the database by hand. */

import { HttpError, errorResponse, json } from '../../../_lib/env.js';
import { createClient, requireAdmin } from '../../../_lib/supabase.js';

/** `params.id` from the `[id].js` filename. Was `params.path` under the previous
    `[[path]].js`, where the id arrived as a one-element array — a shape that
    only made sense because the file was a catch-all. It also meant `/api/admin/jobs`
    never reached ./index.js: a catch-all matches zero segments too. */
function jobId(params) {
  const raw = params?.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id) throw new HttpError(400, 'JOB_ID_REQUIRED', '缺少任务 ID');
  return id;
}

export async function onRequestPost({ request, env, params }) {
  try {
    const { user } = await requireAdmin(env, request);
    const id = jobId(params);
    const body = await request.json().catch(() => ({}));
    const client = createClient(env);

    const rows = await client.select('processing_jobs', `select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    const job = rows?.[0];
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在');

    if (job.state === 'SUCCEEDED' && !body.force) {
      throw new HttpError(409, 'JOB_ALREADY_COMPLETE', '该任务已完成;如需重跑请使用强制重跑。');
    }

    const [updated] = await client.update('processing_jobs', `id=eq.${encodeURIComponent(id)}`, {
      state: 'WAITING',
      // Clearing the lease is what makes a stalled job claimable again. The
      // worker fences on lease ownership, so a still-running holder will stop
      // at its next checkpoint rather than double-writing output.
      lease_until: null,
      next_run_at: new Date().toISOString(),
      automatic_recovery_count: Number(job.automatic_recovery_count || 0) + 1,
      error_code: null,
      error_message: null,
      progress: 0,
      restarted_by: user.id,
      restarted_at: new Date().toISOString(),
    });

    await client.insert('job_events', {
      job_id: id,
      video_id: job.video_id,
      kind: 'MANUAL_RETRY',
      actor: user.id,
      detail: body.reason || null,
      created_at: new Date().toISOString(),
    }).catch(() => null);

    return json({ job: updated });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestDelete({ request, env, params }) {
  try {
    const { user } = await requireAdmin(env, request);
    const id = jobId(params);
    const client = createClient(env);

    const rows = await client.select('processing_jobs', `select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    const job = rows?.[0];
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在');
    if (job.state !== 'RUNNING' && job.state !== 'WAITING') {
      throw new HttpError(409, 'JOB_NOT_CANCELLABLE', `任务状态为 ${job.state},无法取消`);
    }

    const [updated] = await client.update('processing_jobs', `id=eq.${encodeURIComponent(id)}`, {
      state: 'CANCELLED',
      lease_until: null,
      cancelled_by: user.id,
      cancelled_at: new Date().toISOString(),
    });

    await client.insert('job_events', {
      job_id: id,
      video_id: job.video_id,
      kind: 'MANUAL_CANCEL',
      actor: user.id,
      created_at: new Date().toISOString(),
    }).catch(() => null);

    return json({ job: updated });
  } catch (error) {
    return errorResponse(error);
  }
}
