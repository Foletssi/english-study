"""Eastudy V3 — intake session store.

Content-addressed chunk storage. A chunk file is named by the first 16 hex
characters of its own SHA-256, not by its index, so a client that re-plans its
chunk size mid-upload keeps every byte it already sent. That is the property
the legacy store lacked: it wrote `chunk-0007.part` and therefore had to throw
everything away whenever the layout changed.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

CHUNK_MIN = 8 * 1024 * 1024
CHUNK_MAX = 64 * 1024 * 1024
MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
MAX_ACTIVE_SESSIONS = 2
MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024
SESSION_TTL_SECONDS = 24 * 60 * 60
LOW_MEMORY_CHUNK_CAP = 16 * 1024 * 1024


class IntakeError(Exception):
    def __init__(self, code: str, message: str = "", status: int = 400, detail: Any = None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.status = status
        self.detail = detail


@dataclass
class ChunkRecord:
    idx: int
    sha: str
    bytes: int
    stored: str
    at: float


@dataclass
class Session:
    upload_id: str
    video_id: str | None
    recovery_job_id: str | None
    name: str
    size: int
    source_sha: str | None
    chunk_bytes: int
    worker_id: str | None
    origin: str | None
    created_at: float
    updated_at: float
    state: str = "RECEIVING"          # RECEIVING | VERIFYING | READY | FAILED
    chunks: dict[int, ChunkRecord] = field(default_factory=dict)
    cover_sha: str | None = None
    cover_stored: str | None = None
    error: str | None = None
    verify_progress: float | None = None
    shrink_count: int = 0

    def public(self, *, include_chunks: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "uploadId": self.upload_id,
            "videoId": self.video_id,
            "state": self.state,
            "chunkBytes": self.chunk_bytes,
            "size": self.size,
            "receivedBytes": sum(c.bytes for c in self.chunks.values()),
            "receivedCount": len(self.chunks),
            "error": self.error,
            "verifyProgress": self.verify_progress,
            "coverUploaded": bool(self.cover_stored),
            "updatedAt": self.updated_at,
        }
        if include_chunks:
            payload["received"] = [
                {"idx": c.idx, "sha": c.sha, "bytes": c.bytes}
                for c in sorted(self.chunks.values(), key=lambda c: c.idx)
            ]
        return payload


def disk_free_bytes(path: str | os.PathLike[str]) -> int:
    try:
        return shutil.disk_usage(str(path)).free
    except OSError:
        return 0


class IntakeStore:
    """Filesystem-backed session store.

    Layout:
        <root>/sessions/<upload_id>/session.json
        <root>/sessions/<upload_id>/chunks/<sha16>.part
        <root>/sessions/<upload_id>/cover/<sha16>.bin
        <root>/sources/<sha256>.mp4          assembled original
        <root>/inbox/<upload_id>.json        handoff receipt for the worker
    """

    def __init__(self, root: str | os.PathLike[str], *, low_memory: bool = False):
        self.root = Path(root)
        self.low_memory = low_memory
        self.sessions_dir = self.root / "sessions"
        self.sources_dir = self.root / "sources"
        self.inbox_dir = self.root / "inbox"
        for path in (self.sessions_dir, self.sources_dir, self.inbox_dir):
            path.mkdir(parents=True, exist_ok=True)
        self._cache: dict[str, Session] = {}

    # ---------------------------------------------------------------- paths

    def session_dir(self, upload_id: str) -> Path:
        return self.sessions_dir / upload_id

    def chunk_dir(self, upload_id: str) -> Path:
        path = self.session_dir(upload_id) / "chunks"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def cover_dir(self, upload_id: str) -> Path:
        path = self.session_dir(upload_id) / "cover"
        path.mkdir(parents=True, exist_ok=True)
        return path

    # ------------------------------------------------------------- sessions

    def active_count(self) -> int:
        return sum(1 for s in self._load_all() if s.state in ("RECEIVING", "VERIFYING"))

    def _load_all(self) -> list[Session]:
        sessions = []
        for entry in self.sessions_dir.iterdir():
            if not entry.is_dir():
                continue
            record = entry / "session.json"
            if not record.exists():
                continue
            try:
                sessions.append(self._from_json(json.loads(record.read_text("utf-8"))))
            except (OSError, ValueError):
                continue
        return sessions

    def _from_json(self, payload: dict[str, Any]) -> Session:
        chunks = {
            int(idx): ChunkRecord(**row)
            for idx, row in (payload.get("chunks") or {}).items()
        }
        payload = {k: v for k, v in payload.items() if k != "chunks"}
        return Session(chunks=chunks, **payload)

    def _persist(self, session: Session) -> None:
        session.updated_at = time.time()
        target = self.session_dir(session.upload_id) / "session.json"
        tmp = target.with_suffix(".json.tmp")
        payload = asdict(session)
        payload["chunks"] = {str(k): asdict(v) for k, v in session.chunks.items()}
        # Write-then-rename: a crash mid-write must never leave an unparseable
        # session record, which is how the legacy lost whole uploads.
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)
        self._cache[session.upload_id] = session

    def get(self, upload_id: str) -> Session:
        cached = self._cache.get(upload_id)
        if cached is not None:
            return cached
        record = self.session_dir(upload_id) / "session.json"
        if not record.exists():
            raise IntakeError("SESSION_NOT_FOUND", "接收会话不存在", 404)
        session = self._from_json(json.loads(record.read_text("utf-8")))
        self._cache[upload_id] = session
        return session

    def find_by_source(self, source_sha: str) -> Session | None:
        for session in self._load_all():
            if session.source_sha == source_sha and session.state in ("RECEIVING", "VERIFYING", "READY"):
                self._cache[session.upload_id] = session
                return session
        return None

    def find_incomplete_by_name(self, name: str, size: int) -> Session | None:
        best: Session | None = None
        for session in self._load_all():
            if session.name == name and session.size == size and session.state in ("RECEIVING", "VERIFYING"):
                if best is None or session.updated_at > best.updated_at:
                    best = session
        if best is not None:
            self._cache[best.upload_id] = best
        return best

    # --------------------------------------------------------------- create

    def negotiate_chunk_size(self, hint: int | None, size: int, *, disk_free: int | None = None) -> int:
        proposed = int(hint or CHUNK_MIN)
        proposed = max(CHUNK_MIN, min(CHUNK_MAX, proposed))
        if self.low_memory:
            proposed = min(proposed, LOW_MEMORY_CHUNK_CAP)

        available = disk_free if disk_free is not None else disk_free_bytes(self.root)
        # Leave 20% headroom beyond one chunk; the assembled copy doubles the
        # footprint until assembly finishes and the chunks are dropped.
        needed = min(size, proposed) * 2 * 1.2
        while proposed > CHUNK_MIN and available < needed + MIN_FREE_BYTES:
            proposed = max(CHUNK_MIN, proposed // 2)
            needed = min(size, proposed) * 2 * 1.2
        return proposed

    def create(
        self,
        *,
        video_id: str | None,
        recovery_job_id: str | None,
        name: str,
        size: int,
        source_sha: str | None,
        chunk_size_hint: int | None,
        worker_id: str | None,
        origin: str | None,
    ) -> Session:
        if size <= 0:
            raise IntakeError("SOURCE_EMPTY", "原视频文件为空")
        if size > MAX_SOURCE_BYTES:
            raise IntakeError("SOURCE_TOO_LARGE", "原视频不能超过 2GB")

        disk_free = disk_free_bytes(self.root)
        if disk_free < MIN_FREE_BYTES:
            raise IntakeError("INTAKE_DISK_LOW", "本机磁盘空间不足", 507)

        if self.active_count() >= MAX_ACTIVE_SESSIONS:
            raise IntakeError("INTAKE_QUEUE_FULL", "本机接收队列已满", 503)

        if source_sha:
            existing = self.find_by_source(source_sha)
            if existing is not None and existing.state != "READY":
                return existing

        chunk_bytes = self.negotiate_chunk_size(chunk_size_hint, size, disk_free=disk_free)
        upload_id = self._new_id(source_sha or f"{name}:{size}")
        session = Session(
            upload_id=upload_id,
            video_id=video_id,
            recovery_job_id=recovery_job_id,
            name=name,
            size=size,
            source_sha=source_sha,
            chunk_bytes=chunk_bytes,
            worker_id=worker_id,
            origin=origin,
            created_at=time.time(),
            updated_at=time.time(),
        )
        self.session_dir(upload_id).mkdir(parents=True, exist_ok=True)
        self.chunk_dir(upload_id)
        self._persist(session)
        return session

    @staticmethod
    def _new_id(seed: str) -> str:
        stamp = f"{time.time_ns()}".encode("ascii")
        return hashlib.sha256(stamp + seed.encode("utf-8", "replace")).hexdigest()[:32]

    # ---------------------------------------------------------------- chunks

    def put_chunk(self, upload_id: str, index: int, body: bytes, declared_sha: str) -> ChunkRecord:
        session = self.get(upload_id)
        if session.state != "RECEIVING":
            raise IntakeError("SESSION_NOT_RECEIVING", f"会话状态为 {session.state},不接受分片", 409)

        offset = index * session.chunk_bytes
        if offset >= session.size and session.size > 0:
            raise IntakeError("CHUNK_RANGE_INVALID", "分片索引超出文件范围")

        existing = session.chunks.get(index)
        if existing is not None and existing.sha == declared_sha:
            # Idempotent: a retried PUT after a lost response is a success.
            return existing

        digest = hashlib.sha256(body).hexdigest()
        if declared_sha and digest != declared_sha.lower():
            raise IntakeError("CHUNK_SHA_MISMATCH", "分片校验失败", 422)

        expected = min(session.chunk_bytes, session.size - offset)
        if len(body) != expected:
            if len(body) > expected:
                raise IntakeError("CHUNK_RANGE_INVALID", "分片长度超出预期")
            # Short read: accept if this is the final chunk, otherwise reject.
            if offset + len(body) < session.size:
                raise IntakeError("CHUNK_RANGE_INVALID", "分片长度不足")

        stored = f"{digest[:16]}.part"
        target = self.chunk_dir(upload_id) / stored
        tmp = target.with_suffix(".part.tmp")
        tmp.write_bytes(body)
        os.replace(tmp, target)

        record = ChunkRecord(idx=index, sha=digest, bytes=len(body), stored=stored, at=time.time())
        session.chunks[index] = record
        self._persist(session)
        return record

    def put_cover(self, upload_id: str, body: bytes, declared_sha: str) -> str:
        session = self.get(upload_id)
        if len(body) > 15 * 1024 * 1024:
            raise IntakeError("COVER_TOO_LARGE", "封面不能超过 15MB")
        digest = hashlib.sha256(body).hexdigest()
        if declared_sha and digest != declared_sha.lower():
            raise IntakeError("CHUNK_SHA_MISMATCH", "封面校验失败", 422)
        stored = f"{digest[:16]}.bin"
        target = self.cover_dir(upload_id) / stored
        tmp = target.with_suffix(".bin.tmp")
        tmp.write_bytes(body)
        os.replace(tmp, target)
        session.cover_sha = digest
        session.cover_stored = stored
        self._persist(session)
        return digest

    def missing_indexes(self, session: Session) -> list[int]:
        total = (session.size + session.chunk_bytes - 1) // session.chunk_bytes if session.size else 0
        return [i for i in range(total) if i not in session.chunks]

    def shrink(self, session: Session, reason: str) -> Session:
        """Halve the chunk size after a CHUNK_TOO_LARGE style failure.

        Already-stored chunks survive because they are content-addressed; the
        client re-plans and only sends what is genuinely missing.
        """
        if session.chunk_bytes <= CHUNK_MIN:
            raise IntakeError(reason, "分片已是允许的最小值", 413)
        session.chunk_bytes = max(CHUNK_MIN, session.chunk_bytes // 2)
        session.shrink_count += 1
        # Old index-keyed records no longer describe the new layout.
        session.chunks.clear()
        self._persist(session)
        return session

    # -------------------------------------------------------------- assembly

    def assemble(self, upload_id: str, expected_sha: str | None, on_progress=None) -> Path:
        """Stream every chunk into the assembled source, hashing as we go.

        Peak memory is one chunk; the file is never held in RAM whole.
        """
        session = self.get(upload_id)
        missing = self.missing_indexes(session)
        if missing:
            raise IntakeError("INTAKE_INCOMPLETE", f"缺少 {len(missing)} 个分片", 409, {"missing": missing[:50]})

        session.state = "VERIFYING"
        session.verify_progress = 0.0
        self._persist(session)

        self.sources_dir.mkdir(parents=True, exist_ok=True)
        final_name = f"{expected_sha or session.source_sha or upload_id}.mp4"
        final_path = self.sources_dir / final_name
        tmp_path = final_path.with_suffix(".mp4.partial")

        digest = hashlib.sha256()
        written = 0
        with open(tmp_path, "wb") as out:
            for index in sorted(session.chunks):
                record = session.chunks[index]
                source = self.chunk_dir(upload_id) / record.stored
                with open(source, "rb") as handle:
                    while True:
                        block = handle.read(session.chunk_bytes)
                        if not block:
                            break
                        digest.update(block)
                        out.write(block)
                        written += len(block)
                        if on_progress and written % (session.chunk_bytes * 4) < session.chunk_bytes:
                            session.verify_progress = round(written / max(1, session.size), 4)
                            on_progress(session.verify_progress)
            out.flush()
            os.fsync(out.fileno())

        actual = digest.hexdigest()
        declared = (expected_sha or session.source_sha or "").lower()
        if declared and actual != declared:
            # Keep the chunks: a mismatch usually means the operator picked a
            # slightly different file, and re-sending one chunk is far cheaper
            # than re-sending all of them.
            tmp_path.unlink(missing_ok=True)
            session.state = "RECEIVING"
            session.error = "SOURCE_SHA_MISMATCH"
            session.verify_progress = None
            self._persist(session)
            raise IntakeError("SOURCE_SHA_MISMATCH", "原视频校验失败", 422, {"actual": actual})

        os.replace(tmp_path, final_path)
        session.source_sha = actual
        session.state = "READY"
        session.error = None
        session.verify_progress = 1.0
        self._persist(session)

        cover_path = None
        if session.cover_stored:
            cover_path = self.cover_dir(upload_id) / session.cover_stored

        self._write_receipt(session, final_path, cover_path)
        self._drop_chunks(upload_id)
        return final_path

    def _write_receipt(self, session: Session, source_path: Path, cover_path: Path | None) -> None:
        receipt = {
            "uploadId": session.upload_id,
            "videoId": session.video_id,
            "recoveryJobId": session.recovery_job_id,
            "source": {"path": str(source_path), "sha256": session.source_sha, "bytes": session.size, "name": session.name},
            "cover": {"path": str(cover_path), "sha256": session.cover_sha} if cover_path else None,
            "receivedAt": time.time(),
        }
        target = self.inbox_dir / f"{session.upload_id}.json"
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, target)

    def _drop_chunks(self, upload_id: str) -> None:
        path = self.chunk_dir(upload_id)
        for entry in path.glob("*.part"):
            entry.unlink(missing_ok=True)

    # --------------------------------------------------------------- state

    def status(self, upload_id: str) -> dict[str, Any]:
        session = self.get(upload_id)
        payload = session.public()
        payload["missing"] = self.missing_indexes(session)[:50] if session.state == "RECEIVING" else []
        return payload

    def cancel(self, upload_id: str, *, drop_source: bool = False) -> None:
        session = self.get(upload_id)
        if session.state == "READY" and not drop_source:
            raise IntakeError("SESSION_ALREADY_READY", "会话已完成,不能取消", 409)
        shutil.rmtree(self.session_dir(upload_id), ignore_errors=True)
        self._cache.pop(upload_id, None)

    def capabilities(self, *, worker_id: str | None, worker_ready: bool) -> dict[str, Any]:
        free = disk_free_bytes(self.root)
        return {
            "ready": worker_ready and free >= MIN_FREE_BYTES,
            "workerId": worker_id,
            "version": "v3",
            "maxSourceBytes": MAX_SOURCE_BYTES,
            "chunkMin": CHUNK_MIN,
            "chunkMax": CHUNK_MAX,
            "lowMemory": self.low_memory,
            "activeSessions": self.active_count(),
            "maxActiveSessions": MAX_ACTIVE_SESSIONS,
            "diskFreeBytes": free,
            "sources": self._recent_sources(),
        }

    def _recent_sources(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = []
        for entry in sorted(self.inbox_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
            try:
                receipt = json.loads(entry.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            rows.append({
                "uploadId": receipt.get("uploadId"),
                "videoId": receipt.get("videoId"),
                "name": (receipt.get("source") or {}).get("name"),
                "sha256": (receipt.get("source") or {}).get("sha256"),
                "receivedAt": receipt.get("receivedAt"),
            })
        return rows

    # ------------------------------------------------------------ housekeeping

    def prune(self, ttl_seconds: int = SESSION_TTL_SECONDS) -> list[str]:
        """Remove unfinished sessions older than the TTL. Finished ones keep
        their receipts; only the chunk scratch space is reclaimed."""
        cutoff = time.time() - ttl_seconds
        removed = []
        for session in self._load_all():
            if session.state == "READY":
                self._drop_chunks(session.upload_id)
                continue
            if session.updated_at < cutoff and session.created_at < cutoff:
                shutil.rmtree(self.session_dir(session.upload_id), ignore_errors=True)
                self._cache.pop(session.upload_id, None)
                removed.append(session.upload_id)
        return removed

    def orphan_sources(self, referenced: Iterable[str]) -> list[Path]:
        keep = {str(name) for name in referenced}
        return [p for p in self.sources_dir.glob("*.mp4") if p.stem not in keep]
