"""Eastudy V3 — local intake HTTP service (port 8790).

Replaces the legacy 8788/8789 pair. Standard library only: this service runs on
the operator's own machine and must start from a bare Python install without a
dependency step, because it is the thing that has to work when something else
is broken.

Run:
    python -m services.intake.server --port 8790 --data ./runtime/intake
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

if __package__ in (None, ""):  # allow `python services/intake/server.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from services.intake.store import IntakeError, IntakeStore
    from services.intake.tickets import TicketAuthority, generate_worker_id
else:
    from .store import IntakeError, IntakeStore
    from .tickets import TicketAuthority, generate_worker_id

MAX_BODY_BYTES = 72 * 1024 * 1024      # one 64 MiB chunk plus header slack
ALLOWED_ORIGIN_SUFFIXES = (".pages.dev", "localhost", "127.0.0.1", "eastudy")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def origin_allowed(origin: str | None) -> bool:
    """Loopback services must not be reachable from an arbitrary web page.
    Only the product's own origins may issue a browser request here."""
    if not origin:
        return True  # non-browser client (curl, the worker itself)
    host = urlparse(origin).hostname or ""
    return any(host == suffix or host.endswith(suffix) for suffix in ALLOWED_ORIGIN_SUFFIXES)


class IntakeHandler(BaseHTTPRequestHandler):
    server_version = "EastudyIntake/3.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- plumbing

    @property
    def store(self) -> IntakeStore:
        return self.server.store  # type: ignore[attr-defined]

    @property
    def tickets(self) -> TicketAuthority:
        return self.server.tickets  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):  # quieter, structured-ish logging
        if self.server.verbose:  # type: ignore[attr-defined]
            sys.stderr.write("[intake] " + (fmt % args) + "\n")

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Chunk-SHA256")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")

    def _send(self, status: int, payload) -> None:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _fail(self, error: IntakeError | PermissionError) -> None:
        if isinstance(error, PermissionError):
            self._send(401, {"error": str(error), "message": "本机连接验证已过期,正在重新建立连接。"})
            return
        self._send(error.status, {"error": error.code, "message": error.message, "detail": error.detail})

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        if length > MAX_BODY_BYTES:
            raise IntakeError("CHUNK_TOO_LARGE", "分片过大", 413, {"limit": MAX_BODY_BYTES})
        remaining = length
        blocks = []
        while remaining > 0:
            block = self.rfile.read(min(remaining, 4 * 1024 * 1024))
            if not block:
                raise IntakeError("CHUNK_RANGE_INVALID", "请求体提前结束", 400)
            blocks.append(block)
            remaining -= len(block)
        return b"".join(blocks)

    def _json_body(self) -> dict:
        raw = self._body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise IntakeError("BAD_REQUEST", "请求体不是合法 JSON", 400)

    def _token(self) -> str | None:
        header = self.headers.get("Authorization") or ""
        return header[7:].strip() if header.lower().startswith("bearer ") else None

    # -------------------------------------------------------------- routing

    def do_OPTIONS(self):  # noqa: N802
        if not origin_allowed(self.headers.get("Origin")):
            self._send(403, {"error": "ORIGIN_NOT_ALLOWED"})
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path in ("/v3/capability", "/capability"):
                self._capability()
                return
            parts = [p for p in path.split("/") if p]
            if len(parts) == 3 and parts[0] == "v3" and parts[1] == "sessions":
                self.tickets.redeem(self._token())
                self._send(200, self.store.status(parts[2]))
                return
            if path in ("/health", "/v3/health"):
                self._send(200, {"ok": True, "service": "eastudy-intake", "version": "v3"})
                return
            self._send(404, {"error": "NOT_FOUND"})
        except (IntakeError, PermissionError) as error:
            self._fail(error)
        except Exception:  # pragma: no cover - defensive
            traceback.print_exc()
            self._send(500, {"error": "INTERNAL"})

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path in ("/v3/sessions", "/sessions"):
                self._open_session()
                return
            parts = [p for p in path.split("/") if p]
            if len(parts) == 4 and parts[:2] == ["v3", "sessions"] and parts[3] == "complete":
                self.tickets.redeem(self._token())
                self._complete(parts[2])
                return
            if path in ("/v3/handshake", "/handshake"):
                self._handshake()
                return
            if path in ("/v3/ticket/refresh",):
                ticket = self.tickets.refresh(self._token() or "")
                self._send(200, {"ticket": ticket.value, "expiresAt": ticket.expires_at})
                return
            self._send(404, {"error": "NOT_FOUND"})
        except (IntakeError, PermissionError) as error:
            self._fail(error)
        except Exception:  # pragma: no cover - defensive
            traceback.print_exc()
            self._send(500, {"error": "INTERNAL"})

    def do_PUT(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            parts = [p for p in path.split("/") if p]
            if len(parts) == 5 and parts[:2] == ["v3", "sessions"] and parts[3] == "chunks":
                self.tickets.redeem(self._token())
                self._put_chunk(parts[2], parts[4])
                return
            if len(parts) == 4 and parts[:2] == ["v3", "sessions"] and parts[3] == "cover":
                self.tickets.redeem(self._token())
                self._put_cover(parts[2])
                return
            self._send(404, {"error": "NOT_FOUND"})
        except (IntakeError, PermissionError) as error:
            self._fail(error)
        except Exception:  # pragma: no cover - defensive
            traceback.print_exc()
            self._send(500, {"error": "INTERNAL"})

    def do_DELETE(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            parts = [p for p in path.split("/") if p]
            if len(parts) == 3 and parts[:2] == ["v3", "sessions"]:
                self.tickets.redeem(self._token())
                self.store.cancel(parts[2])
                self._send(200, {"cancelled": parts[2]})
                return
            self._send(404, {"error": "NOT_FOUND"})
        except (IntakeError, PermissionError) as error:
            self._fail(error)
        except Exception:  # pragma: no cover
            traceback.print_exc()
            self._send(500, {"error": "INTERNAL"})

    # ------------------------------------------------------------- handlers

    def _capability(self) -> None:
        payload = self.store.capabilities(
            worker_id=self.tickets.worker_id,
            worker_ready=self.server.worker_ready,  # type: ignore[attr-defined]
        )
        payload["challenge"] = self.tickets.issue_challenge(self.headers.get("X-Eastudy-Admin") or "anonymous")
        self._send(200, payload)

    def _handshake(self) -> None:
        body = self._json_body()
        challenge = body.get("challenge") or ""
        if not origin_allowed(self.headers.get("Origin")):
            raise PermissionError("ORIGIN_NOT_ALLOWED")
        try:
            admin_id = self.tickets.consume_challenge(challenge)
        except PermissionError:
            raise PermissionError("INTAKE_TICKET_INVALID")
        ticket = self.tickets.mint(admin_id)
        self._send(200, {"ticket": ticket.value, "expiresAt": ticket.expires_at, "workerId": ticket.worker_id})

    def _open_session(self) -> None:
        body = self._json_body()
        source = body.get("source") or {}
        session = self.store.create(
            video_id=body.get("videoId") or (body.get("video") or {}).get("id"),
            recovery_job_id=body.get("recoveryJobId"),
            name=source.get("name") or "unknown",
            size=int(source.get("size") or 0),
            source_sha=(source.get("sha256") or None),
            chunk_size_hint=int(body.get("chunkSizeHint") or 0) or None,
            worker_id=body.get("workerId"),
            origin=body.get("origin") or self.headers.get("Origin"),
        )
        payload = session.public()
        payload["uploadPath"] = f"/v3/sessions/{session.upload_id}"
        payload["ticket"] = self.tickets.mint(session.worker_id or "anonymous").value
        self._send(200, payload)

    def _put_chunk(self, upload_id: str, index_raw: str) -> None:
        try:
            index = int(index_raw)
        except ValueError:
            raise IntakeError("CHUNK_RANGE_INVALID", "分片索引不是整数")
        body = self._body()
        declared = (self.headers.get("X-Chunk-SHA256") or "").strip()
        try:
            record = self.store.put_chunk(upload_id, index, body, declared)
        except IntakeError as error:
            if error.code == "CHUNK_TOO_LARGE":
                session = self.store.get(upload_id)
                self.store.shrink(session, "CHUNK_TOO_LARGE")
                raise IntakeError("CHUNK_TOO_LARGE", "分片过大,已减半,请重新协商", 413,
                                  {"chunkBytes": session.chunk_bytes})
            raise
        self._send(200, {"idx": record.idx, "sha": record.sha, "bytes": record.bytes})

    def _put_cover(self, upload_id: str) -> None:
        body = self._body()
        declared = (self.headers.get("X-Chunk-SHA256") or "").strip()
        sha = self.store.put_cover(upload_id, body, declared)
        self._send(200, {"sha": sha, "bytes": len(body)})

    def _complete(self, upload_id: str) -> None:
        body = self._json_body()
        expected = body.get("sha256") or None
        session = self.store.get(upload_id)
        missing = self.store.missing_indexes(session)
        if missing:
            raise IntakeError("INTAKE_INCOMPLETE", f"还缺少 {len(missing)} 个分片", 409, {"missing": missing[:50]})

        # Assembly is CPU/disk bound; run it inline but stream progress so the
        # client's 99% state is honest rather than a frozen spinner.
        path = self.store.assemble(upload_id, expected)
        job = enqueue_local_job(self.server, self.store.get(upload_id), path)
        payload = self.store.status(upload_id)
        payload["state"] = "READY"
        payload["job"] = job
        self._send(200, payload)


def enqueue_local_job(server, session, source_path: Path) -> dict:
    """Hand the assembled source to the processing pipeline.

    Deliberately a thin handoff: this service's job ends at "the bytes are
    correct on disk". Writing a job row is the pipeline's business, and if the
    pipeline is not running we still return success, because the receipt file
    is the durable record and the worker picks it up whenever it starts.
    """
    job = {
        "videoId": session.video_id,
        "recoveryJobId": session.recovery_job_id,
        "sourcePath": str(source_path),
        "sourceSha256": session.source_sha,
        "coverPath": str(server.store.cover_dir(session.upload_id) / session.cover_stored) if session.cover_stored else None,
        "enqueuedAt": time.time(),
        "state": "WAITING",
    }
    server.jobs.put(job)
    return job


class JobQueue:
    """In-memory handoff queue. The durable record is the inbox receipt file;
    this only exists so a running worker notices immediately."""

    def __init__(self, limit: int = 64):
        self._items: list[dict] = []
        self._lock = threading.Lock()
        self._limit = limit

    def put(self, job: dict) -> None:
        with self._lock:
            self._items.append(job)
            if len(self._items) > self._limit:
                del self._items[: len(self._items) - self._limit]

    def drain(self) -> list[dict]:
        with self._lock:
            items, self._items = self._items, []
            return items

    def __len__(self) -> int:
        return len(self._items)


def build_server(*, port: int, data_dir: str, low_memory: bool = False, worker_ready: bool = True, verbose: bool = False):
    server = ThreadingHTTPServer(("127.0.0.1", port), IntakeHandler)
    server.daemon_threads = True
    server.store = IntakeStore(data_dir, low_memory=low_memory)   # type: ignore[attr-defined]
    server.tickets = TicketAuthority(worker_id=generate_worker_id())  # type: ignore[attr-defined]
    server.jobs = JobQueue()                                      # type: ignore[attr-defined]
    server.worker_ready = worker_ready                            # type: ignore[attr-defined]
    server.verbose = verbose                                      # type: ignore[attr-defined]
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Eastudy V3 本机接收服务")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--data", default="./runtime/intake")
    parser.add_argument("--low-memory", action="store_true", help="分片上限压到 16MiB,适合内存紧张的机器")
    parser.add_argument("--not-ready", action="store_true", help="标记处理组件未就绪,仅用于测试握手失败路径")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    server = build_server(
        port=args.port,
        data_dir=args.data,
        low_memory=args.low_memory,
        worker_ready=not args.not_ready,
        verbose=args.verbose,
    )
    removed = server.store.prune()
    if removed:
        print(f"[intake] 清理了 {len(removed)} 个过期会话")
    print(f"[intake] 监听 http://127.0.0.1:{args.port}  workerId={server.tickets.worker_id}")
    print(f"[intake] 数据目录 {Path(args.data).resolve()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[intake] 已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
