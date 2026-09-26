/* Eastudy V3 — system health and settings (M10).

   Health is a read of real dependencies: our own edge API, the intake service
   running on the operator's machine, and the last heartbeat the worker wrote.
   Nothing here is a hard-coded green dot — the legacy's health card showed
   "正常" even when the worker had been dead for days. */

import { ApiError } from '../core/http.js';

export function createSystemService({ api, intakeUrl }) {
  async function settings() {
    return api.get('/api/admin/settings');
  }

  async function saveSettings(patch) {
    return api.put('/api/admin/settings', patch, { retry: false });
  }

  async function aiConfig() {
    return api.get('/api/admin/settings/ai');
  }

  async function saveAiConfig(patch) {
    return api.put('/api/admin/settings/ai', patch, { retry: false });
  }

  /** 第三方通道检测 / 模型获取。
   *
   *  走我们自己的接口而不是浏览器直连第三方 —— key 存在服务端, 一旦直连就
   *  得把 key 下发到前端, 那正是 settings/ai.js 整个文件在避免的事。
   *
   *  retry: false。这是运维手点的一次动作, 失败要立刻看见原因; 自动重试会
   *  让他多点几次按钮之后才看到结果, 而且每次重试都是一次真实的计费调用。
   *
   *  @param {{ mode: 'models'|'test'|'key', base_url?: string, api_key?: string, model?: string }} payload
   */
  async function probeAi(payload) {
    return api.post('/api/admin/settings/ai/probe', payload, { retry: false });
  }

  /** Probe the local intake service directly. It is bound to 127.0.0.1 so the
      browser can reach it while the edge API cannot — this is the one check
      that has to run client-side. */
  async function intakeHealth({ timeoutMs = 2500 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${intakeUrl}/capability`, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
      const body = await response.json();
      return { ok: true, detail: body };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      return { ok: false, detail: aborted ? '连接超时' : '未启动或不可达' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function workerStatus() {
    return api.get('/api/admin/settings/worker');
  }

  /** Highest-entropy single check on the dashboard: if this fails, everything
      downstream of login is suspect. */
  async function edgeHealth() {
    try {
      await api.get('/api/admin/session');
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof ApiError ? error.message : String(error?.message || error) };
    }
  }

  async function overview() {
    const [edge, intake, worker] = await Promise.all([
      edgeHealth(),
      intakeHealth(),
      workerStatus().catch((error) => ({ ok: false, detail: error?.message || '不可用' })),
    ]);
    return { edge, intake, worker, checkedAt: new Date().toISOString() };
  }

  return { settings, saveSettings, aiConfig, saveAiConfig, probeAi, intakeHealth, workerStatus, edgeHealth, overview };
}
