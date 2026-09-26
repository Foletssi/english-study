from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any


class SupabaseError(RuntimeError):
    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(message)
        self.status, self.body = status, body


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SupabaseClient:
    def __init__(self, url: str, service_key: str, opener=None):
        self.url = url.rstrip("/")
        self.service_key = service_key
        self.opener = opener or urllib.request.build_opener()

    def request(self, method: str, path: str, body: Any = None, *, headers=None) -> Any:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        request = urllib.request.Request(
            f"{self.url}/rest/v1/{path.lstrip('/')}", data=data, method=method,
            headers={"apikey": self.service_key, "Authorization": f"Bearer {self.service_key}",
                     "Content-Type": "application/json", "Accept": "application/json",
                     **(headers or {})},
        )
        try:
            with self.opener.open(request, timeout=60) as response:
                raw = response.read()
                if not raw:
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = raw
            raise SupabaseError(error.code, f"Supabase {error.code}: {raw[:500]}", parsed) from error

    def select(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode(params, safe="(),.*")
        value = self.request("GET", f"{table}?{query}")
        return value if isinstance(value, list) else []

    def insert(self, table: str, row: dict[str, Any]) -> dict[str, Any] | None:
        value = self.request("POST", table, row, headers={"Prefer": "return=representation"})
        return value[0] if isinstance(value, list) and value else value

    def update(self, table: str, filters: dict[str, str], values: dict[str, Any]) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode(filters, safe="(),.*")
        value = self.request("PATCH", f"{table}?{query}", values,
                             headers={"Prefer": "return=representation"})
        return value if isinstance(value, list) else []

    def rpc(self, name: str, args: dict[str, Any]) -> Any:
        return self.request("POST", f"rpc/{name}", args)

    def setting(self, key: str) -> Any:
        """读一行 settings, 返回它的 value (没有这行返回 None)。

        表结构是 (key text primary key, value text, updated_at) —— 跟控制端的
        `functions/api/admin/settings/ai.js` 读的是同一张表。控制端**写**, 这里
        **读**, 这是两个方向唯一的通道, 所以表名和列名必须一致, 不能靠约定。

        `value` 是 **text** 不是 jsonb (见 0001_init.sql: 那张表同时存标量和
        AI 配置的 JSON 串)。所以这里拿回来的是字符串, 解析由
        `config.resolve_ai_settings` 负责 —— 它同时吃得下 dict 和字符串, 因为
        PostgREST 未来若把该列换成 jsonb, 行为不该跟着变。"""
        rows = self.select("settings", {"select": "value", "key": f"eq.{key}", "limit": "1"})
        if not rows:
            return None
        return rows[0].get("value")

    def upsert_subtitles(self, video_id: str, sentences: list[dict[str, Any]], revision: int = 1) -> None:
        self.request("POST", "video_subtitles", {"video_id": video_id, "sentences": sentences, "revision": revision},
                     headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def heartbeat(self, worker_id: str, status: str, version: str, current_job_id=None, detail=None) -> None:
        row = {"worker_id": worker_id, "status": status, "version": version,
               "current_job_id": current_job_id, "last_seen_at": utc_now(), "detail": detail or {}}
        self.request("POST", "worker_heartbeats", row,
                     headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
