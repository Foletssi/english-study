from __future__ import annotations

import argparse
import json
import logging
import signal
import threading
import time
from pathlib import Path

from . import prompts
from .ai import AIError, enrich_subtitles, stamp
from .config import WorkerConfig, resolve_ai_settings
from .media import extract_audio, make_cover, probe, transcode_hls, transcribe
from .r2 import R2Uploader
from .supabase import SupabaseClient, SupabaseError, utc_now

log = logging.getLogger("eastudy.worker")


class Worker:
    def __init__(self, config: WorkerConfig, db=None, uploader=None):
        self.config = config
        self.db = db or SupabaseClient(config.supabase_url, config.supabase_key)
        self.uploader = uploader or R2Uploader(getattr(config, "r2_endpoint", None), getattr(config, "r2_access_key", None), getattr(config, "r2_secret_key", None), getattr(config, "r2_bucket", None))
        self.stop_requested = False
        self.current_job = None
        self.lease_until = None
        # 上一次打过的 AI 配置来源。只在来源变了的时候打日志 —— 每个 job 都打一
        # 行一样的字, 真出事的时候那行会被淹掉。初始化成 None 而不是走到属性不
        # 存在, 那样第一次调用会在 NoSuchAttribute 上炸掉, 而症状是"AI 段起不来"
        # 这种离原因很远的表现。
        self._ai_source_logged = None

    def _renew_loop(self, job_id: str, stop: threading.Event):
        interval = max(10, int(self.config.lease_seconds / 3))
        while not stop.wait(interval):
            try:
                self._progress(job_id, self._stage, self._progress_value)
                self.heartbeat("BUSY", {"stage": self._stage, "progress": self._progress_value})
            except Exception as error:
                log.warning("lease renewal failed for %s: %s", job_id, error)
                return
        config.work_root.mkdir(parents=True, exist_ok=True)

    def stop(self, *_):
        self.stop_requested = True

    def heartbeat(self, status: str, detail=None):
        try:
            self.db.heartbeat(self.config.worker_id, status, self.config.version, self.current_job, detail)
        except Exception as error:
            log.warning("heartbeat failed: %s", error)

    def ensure_jobs(self):
        inbox = self.config.intake_root / "inbox"
        for receipt_path in sorted(inbox.glob("*.json")):
            if receipt_path.name.endswith(".queued.json") or receipt_path.name.endswith(".done.json"):
                continue
            try:
                receipt = json.loads(receipt_path.read_text("utf-8"))
                video_id = receipt.get("videoId")
                source = receipt.get("source") or {}
                if not video_id or not source.get("path"):
                    log.error("skip invalid intake receipt %s", receipt_path)
                    continue
                existing = self.db.select("processing_jobs", {"select": "id,state", "video_id": f"eq.{video_id}", "order": "created_at.desc", "limit": "1"})
                latest = existing[0] if existing else None
                recovery_job_id = receipt.get("recoveryJobId")
                needs_new = latest is None or (latest.get("state") in {"SUCCEEDED", "CANCELLED", "FAILED"} and str(recovery_job_id or "") != str(latest.get("id") or ""))
                if needs_new:
                    job = self.db.insert("processing_jobs", {"video_id": video_id, "state": "WAITING", "stage": "QUEUED", "progress": 0, "next_run_at": utc_now()})
                    if job and job.get("id"):
                        self.db.update("videos", {"id": f"eq.{video_id}"}, {"job_id": job["id"], "status": "PROCESSING", "pipeline_status": "WAITING", "source_sha256": source.get("sha256"), "source_bytes": source.get("bytes"), "source_name": source.get("name"), "source_received_at": utc_now()})
                receipt_path.with_suffix(".queued.json").write_text(receipt_path.read_text("utf-8"), encoding="utf-8")
                receipt_path.unlink(missing_ok=True)
            except (OSError, ValueError, SupabaseError) as error:
                log.warning("intake handoff failed for %s: %s", receipt_path, error)

    def claim(self) -> dict | None:
        try:
            result = self.db.rpc("worker_claim_job", {"p_worker_id": self.config.worker_id, "p_lease_seconds": self.config.lease_seconds})
            if isinstance(result, dict):
                self.lease_until = result.get("lease_until") or self._new_lease()
                return result
            if isinstance(result, list) and result:
                self.lease_until = result[0].get("lease_until") or self._new_lease()
                return result[0]
        except SupabaseError as error:
            if error.status not in (404, 400):
                raise
            # Works against an older database before the RPC migration is applied.
            rows = self.db.select("processing_jobs", {"select": "*", "state": "eq.WAITING", "order": "created_at.asc", "limit": "1"})
            if rows:
                row = rows[0]
                claimed = self.db.update("processing_jobs", {"id": f"eq.{row['id']}", "state": "eq.WAITING"}, {"state": "RUNNING", "stage": "PROBE", "lease_until": f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + self.config.lease_seconds))}", "attempt": int(row.get("attempt") or 0) + 1})
                if claimed:
                    self.lease_until = claimed[0].get("lease_until")
                    return claimed[0]
        return None

    def process(self, job: dict):
        job_id, video_id = job["id"], job["video_id"]
        self.current_job = job_id
        receipt = self._receipt_for(video_id)
        if not receipt:
            raise RuntimeError("INTAKE_RECEIPT_NOT_FOUND")
        source = Path(receipt["source"]["path"])
        output = self.config.work_root / job_id
        output.mkdir(parents=True, exist_ok=True)
        self._stage, self._progress_value = "PROBE", 5
        renew_stop = threading.Event()
        renewer = threading.Thread(target=self._renew_loop, args=(job_id, renew_stop), daemon=True)
        renewer.start()
        try:
            self._progress(job_id, "PROBE", 5)
            probe_checkpoint = output / "probe.json"
            if probe_checkpoint.exists():
                try:
                    info = json.loads(probe_checkpoint.read_text("utf-8"))
                except (OSError, ValueError):
                    info = probe(source)
            else:
                info = probe(source)
            probe_checkpoint.write_text(json.dumps(info), encoding="utf-8")
            audio = extract_audio(source, output / "audio.wav")
            self._progress(job_id, "TRANSCODE", 20)
            self._stage, self._progress_value = "TRANSCODE", 20
            transcode_hls(source, output / "media", info)
            cover_input = receipt.get("cover", {}).get("path") if receipt.get("cover") else None
            make_cover(source, output / "media" / "cover.webp", info["duration"], Path(cover_input) if cover_input else None)
            self._progress(job_id, "ASR", 50)
            self._stage, self._progress_value = "ASR", 50
            transcript_checkpoint = output / "transcript.json"
            if transcript_checkpoint.exists():
                try:
                    rows = json.loads(transcript_checkpoint.read_text("utf-8"))
                except (OSError, ValueError):
                    rows = transcribe(audio, video_id, info["duration"], self.config.whisper_model, self.config.whisper_device, self.config.whisper_compute)
            else:
                rows = transcribe(audio, video_id, info["duration"], self.config.whisper_model, self.config.whisper_device, self.config.whisper_compute)
            transcript_checkpoint.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
            self._progress(job_id, "AI", 72)
            self._stage, self._progress_value = "AI", 72
            subtitle_checkpoint = output / "subtitles.json"
            subtitles = self._read_checkpoint(subtitle_checkpoint)
            if subtitles is None:
                # 只有真要跑 AI 时才解析配置 —— 从 checkpoint 恢复时那次查询是白
                # 查的, 而且它会在日志里打一行"配置来源", 让一次纯恢复看起来像
                # 一次真调用。
                ai_config, _ = self._ai_config()
                subtitles, degraded = self._run_ai(rows, ai_config)
            else:
                # 恢复时重新推断降级状态: 整个列表没有一条翻译, 就是降级产出。
                # 不这么做的话, 重跑一次就会把 PARTIAL 洗成 READY —— 而且恰好
                # 是在上游出过问题、最需要看见这个标记的时候。
                degraded = not any(sentence.get("translation") for sentence in subtitles)
            subtitle_checkpoint.write_text(json.dumps(subtitles, ensure_ascii=False, indent=2), encoding="utf-8")
            (output / "media" / "subtitles.json").write_text(json.dumps(subtitles, ensure_ascii=False, indent=2), encoding="utf-8")
            prefix = f"{self.config.r2_prefix}/{video_id}/{job_id}"
            self._progress(job_id, "UPLOAD", 90)
            self._stage, self._progress_value = "UPLOAD", 90
            self.uploader.upload_tree(output / "media", prefix)
            self.db.upsert_subtitles(video_id, subtitles) if hasattr(self.db, "upsert_subtitles") else self.db.request("POST", "video_subtitles", {"video_id": video_id, "sentences": subtitles, "revision": 1}, headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
            self.db.update("videos", {"id": f"eq.{video_id}"}, {"playback_prefix": prefix, "status": "REVIEW", "pipeline_status": "PARTIAL" if degraded else "READY", "duration_seconds": round(info["duration"])})
            self.db.update("processing_jobs", self._fence(job_id), {"state": "SUCCEEDED", "stage": "PUBLISHED", "progress": 100, "lease_until": None, "updated_at": utc_now()})
            self._mark_receipt_done(video_id)
        finally:
            renew_stop.set()
            renewer.join(timeout=2)

    @staticmethod
    def _read_checkpoint(path: Path):
        """读一个 checkpoint, 坏掉 / 不存在都当"没有"。

        跟这一段的 probe.json / transcript.json 用的是同一条规矩: 半截的 JSON
        说明上次是在写它的过程中死的, 那就重跑那一步, 而不是拿半截数据往下走。
        这里的差别是它返回 None 而不是就地兜底 —— 因为兜底要用到 rows 和配置,
        那些是调用方的事。"""
        if not path.exists():
            return None
        try:
            value = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        return value if isinstance(value, list) and value else None

    def _ai_config(self) -> tuple[WorkerConfig, bool]:
        """每次取活时重新解析 AI 配置, 而不是启动时解析一次。

        控制端改完设置就生效 —— 不用重启 worker。这不是"顺手优化": 一个运维
        在设置页改完之后, 没有任何提示告诉他"要重启那个 Python 进程", 而症状
        是"我改了但没反应", 他会去改别的、去重启、去怀疑密钥 —— 排查的是错的
        方向。一次查询而已, 比这便宜得多。

        读失败时**不换成 None**: 保留上次拿到的配置继续跑。settings 表一时的
        网络抖动不该让 AI 段降级, 那会产出一批没有翻译的字幕而没人看得出原因。
        但失败的那次不进缓存, 下一个 job 会再试一次, 所以表恢复之后能自己好。"""
        try:
            settings = resolve_ai_settings(self.config, self.db)
        except Exception as error:                       # noqa: BLE001
            log.warning("AI 配置解析失败, 继续用上次的: %s", error)
            return self.config, False

        if settings.source != self._ai_source_logged:
            log.info("AI 配置来源: %s (enabled=%s, model=%s)", settings.source, settings.enabled, settings.model or "-")
            self._ai_source_logged = settings.source

        return self.config.with_ai(settings), False

    def _run_ai(self, rows: list[dict], config: WorkerConfig) -> tuple[list[dict], bool]:
        """跑 AI 段。返回 (字幕, 是否降级)。

        上游挂了**不**让 job 失败。理由: 这个 job 已经付出了 ASR 那一步 (通常
        是最慢的), 把它整个作废, 重跑要再付一次; 而字幕本身是好的, 只是没有
        翻译和释义。降级发布 + 留下痕迹, 比失败重跑更省, 也更快让学员看到东西。

        但"降级"必须留下痕迹 —— 一个没有翻译的字幕和一个翻译没写好的字幕, 在
        学员那边看起来一样。所以这里把原因写进日志, 并把 pipeline_status 标成
        PARTIAL (见 process), 控制端的任务卡上能看到。

        唯一的例外是 AI_NOT_CONFIGURED: 那不是"上游出问题", 是"运维以为开着
        但没配"。这种错要被看见, 所以往上抛, job 失败, 原因写在 error_message
        里。这是 `enrich_subtitles` 里就定好的分工。"""
        prompt_version = prompts.prompt_version()
        if not config.ai_enabled:
            log.info("AI 段已关闭, 只出字幕不出翻译 (prompt_version=%s)", prompt_version)
            return stamp(enrich_subtitles(rows, None, None, None, enabled=False)), True

        try:
            return stamp(enrich_subtitles(rows, config.ai_base_url, config.ai_api_key, config.ai_model)), False
        except AIError as error:
            if error.code == "AI_NOT_CONFIGURED":
                raise
            log.error("AI 段调用失败, 降级发布字幕 (无翻译): %s", error)
            return stamp(enrich_subtitles(rows, None, None, None, enabled=False)), True

    def _receipt_for(self, video_id: str) -> dict | None:
        for path in (self.config.intake_root / "inbox").glob("*.queued.json"):
            try:
                receipt = json.loads(path.read_text("utf-8"))
                if receipt.get("videoId") == video_id:
                    return receipt
            except (OSError, ValueError):
                continue
        return None

    def _mark_receipt_done(self, video_id: str) -> None:
        for path in (self.config.intake_root / "inbox").glob("*.queued.json"):
            try:
                if json.loads(path.read_text("utf-8")).get("videoId") == video_id:
                    path.rename(path.with_name(path.name.replace(".queued.json", ".done.json")))
                    return
            except (OSError, ValueError):
                continue

    def _progress(self, job_id: str, stage: str, progress: int):
        self._stage, self._progress_value = stage, progress
        renewed = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + self.config.lease_seconds))
        updated = self.db.update("processing_jobs", self._fence(job_id), {"stage": stage, "progress": progress, "lease_until": renewed})
        if not updated:
            raise RuntimeError("JOB_LEASE_LOST")
        self.lease_until = renewed
        self.heartbeat("BUSY", {"stage": stage, "progress": progress})

    def _new_lease(self) -> str:
        return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + self.config.lease_seconds))

    def _fence(self, job_id: str) -> dict[str, str]:
        filters = {"id": f"eq.{job_id}", "state": "eq.RUNNING"}
        if self.lease_until:
            filters["lease_until"] = f"eq.{self.lease_until}"
        return filters

    def fail(self, job: dict, error: Exception):
        code = getattr(error, "code", "WORKER_FAILED")
        message = getattr(error, "message", str(error))[:1000]
        self.db.update("processing_jobs", self._fence(job["id"]), {"state": "FAILED", "stage": "FAILED", "progress": min(99, int(job.get("progress") or 0)), "lease_until": None, "error_code": code, "error_message": message, "updated_at": utc_now()})
        self.db.update("videos", {"id": f"eq.{job['video_id']}"}, {"status": "PROCESSING", "pipeline_status": "FAILED"})

    def run_once(self) -> bool:
        self.ensure_jobs()
        job = self.claim()
        if not job:
            self.heartbeat("IDLE")
            return False
        self.heartbeat("BUSY", {"stage": job.get("stage")})
        try:
            self.process(job)
        except Exception as error:
            log.exception("job %s failed", job.get("id"))
            self.fail(job, error)
        finally:
            self.current_job = None
            self.lease_until = None
            self.heartbeat("IDLE")
        return True

    def run(self):
        self.heartbeat("STARTING")
        while not self.stop_requested:
            self.run_once()
            if not self.stop_requested:
                time.sleep(self.config.poll_seconds)
        self.heartbeat("STOPPED")


def main() -> int:
    parser = argparse.ArgumentParser(description="Eastudy V3 media worker")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = WorkerConfig.from_env()
    worker = Worker(config)
    signal.signal(signal.SIGINT, worker.stop)
    signal.signal(signal.SIGTERM, worker.stop)
    if args.once:
        worker.run_once()
    else:
        worker.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
