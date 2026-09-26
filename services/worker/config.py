from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


@dataclass(frozen=True)
class AiSettings:
    """AI 段的运行时配置。

    `enabled=False` 时 worker **不调用上游**, 只出没有翻译和释义的字幕。这个
    开关在控制端设置页上, 运维关掉它就该真的关掉 —— 之前的版本 worker 侧根本
    没读它, 关掉等于没关。

    `source` 不是给程序逻辑用的, 是给运维看的: 控制端显示"已开启", 而 worker
    实际用的是环境变量, 这种错位只能靠日志里一行 "AI 配置来源: settings 表"
    来定位。没有这一行, "我明明开了它怎么没跑" 就是一个查不出来的问题。"""
    enabled: bool
    base_url: str | None
    api_key: str | None
    model: str | None
    source: str = "env"


@dataclass(frozen=True)
class WorkerConfig:
    supabase_url: str
    supabase_key: str
    intake_root: Path
    worker_id: str
    version: str
    lease_seconds: int = 300
    poll_seconds: float = 5.0
    r2_endpoint: str | None = None
    r2_access_key: str | None = None
    r2_secret_key: str | None = None
    r2_bucket: str | None = None
    r2_prefix: str = "videos"
    ai_base_url: str | None = None
    ai_api_key: str | None = None
    ai_model: str | None = None
    ai_enabled: bool = True
    ai_source: str = "env"
    whisper_model: str = "small"
    whisper_device: str = "cpu"
    whisper_compute: str = "int8"
    work_root: Path = Path("./runtime/worker")

    @property
    def ai(self) -> AiSettings:
        return AiSettings(
            enabled=self.ai_enabled,
            base_url=self.ai_base_url,
            api_key=self.ai_api_key,
            model=self.ai_model,
            source=self.ai_source,
        )

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        return cls(
            supabase_url=_required("SUPABASE_URL").rstrip("/"),
            supabase_key=_required("SUPABASE_SERVICE_ROLE_KEY"),
            intake_root=Path(os.getenv("INTAKE_DATA", "./runtime/intake")).resolve(),
            worker_id=os.getenv("WORKER_ID", "eastudy-worker-1"),
            version=os.getenv("WORKER_VERSION", "3.0.0"),
            lease_seconds=int(os.getenv("WORKER_LEASE_SECONDS", "300")),
            poll_seconds=float(os.getenv("WORKER_POLL_SECONDS", "5")),
            r2_endpoint=os.getenv("R2_ENDPOINT") or None,
            r2_access_key=os.getenv("R2_ACCESS_KEY_ID") or None,
            r2_secret_key=os.getenv("R2_SECRET_ACCESS_KEY") or None,
            r2_bucket=os.getenv("R2_BUCKET") or None,
            r2_prefix=os.getenv("R2_PREFIX", "videos").strip("/") or "videos",
            # 这两组是**兜底**: 控制端 settings 表读不到时才用它们。见
            # `resolve_ai_settings` 里的优先级说明。
            ai_base_url=os.getenv("DEEPSEEK_BASE_URL") or os.getenv("AI_BASE_URL") or None,
            ai_api_key=os.getenv("DEEPSEEK_API_KEY") or os.getenv("AI_API_KEY") or None,
            ai_model=os.getenv("DEEPSEEK_MODEL") or os.getenv("AI_MODEL") or None,
            # 环境变量里的 AI_ENABLED 默认 true: 老部署没有这一项, 行为不变。
            ai_enabled=_bool_env("AI_ENABLED", True),
            ai_source="env",
            whisper_model=os.getenv("WHISPER_MODEL", "small"),
            whisper_device=os.getenv("WHISPER_DEVICE", "cpu"),
            whisper_compute=os.getenv("WHISPER_COMPUTE", "int8"),
            work_root=Path(os.getenv("WORK_ROOT", "./runtime/worker")).resolve(),
        )

    def with_ai(self, settings: AiSettings) -> "WorkerConfig":
        """换掉 AI 那几项, 其余不动。config 是 frozen 的, 所以返回一份新的。"""
        return replace(
            self,
            ai_base_url=settings.base_url,
            ai_api_key=settings.api_key,
            ai_model=settings.model,
            ai_enabled=settings.enabled,
            ai_source=settings.source,
        )


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


#: settings 表里这一行存的是 AI 配置 (跟 functions/api/admin/settings/ai.js 的
#: CONFIG_KEY 是同一个值)。两边都写 `'ai'`, 改一处必须改另一处 —— 测试会断言。
SETTINGS_KEY = "ai"


def resolve_ai_settings(base: WorkerConfig, db) -> AiSettings:
    """控制端的配置优先于环境变量。

    优先级是刻意的, 而且是这次改动的全部意义所在: 运维在设置页上填了地址和
    密钥、点了"检测通道"看见绿字, 那么**真正跑起来必须用它**。之前 worker 只
    读环境变量, 于是表单是一张装饰 —— 填了不生效, 关了也不生效, 而控制台显示
    "已开启"。运维据此判断"AI 已经在跑, 只是效果不好", 而实际上一次上游调用
    都没发生过。

    settings 表读不到 (网络问题、没建表、行不存在) 时退回环境变量, 并**不抛错**:
    worker 的主要职责是把视频转码发布, 一个读不到的 AI 配置不该让整个仓库停摆。
    读到的那份来源会记进 `source`, 启动日志里打一行。

    控制端把 `enabled` 存成布尔, 但库里是可手改的 text, 所以这里接受多种写法。"""
    try:
        rows = db.select("settings", {"select": "value", "key": f"eq.{SETTINGS_KEY}", "limit": "1"})
    except Exception as error:                       # noqa: BLE001 — 见上面的说明
        return AiSettings(
            enabled=base.ai_enabled,
            base_url=base.ai_base_url,
            api_key=base.ai_api_key,
            model=base.ai_model,
            source=f"env (settings 表读取失败: {error})",
        )

    if not rows:
        return base.ai

    raw = rows[0].get("value")
    stored = raw if isinstance(raw, dict) else _parse_json(raw)
    if not stored:
        return base.ai

    enabled_raw = stored.get("enabled")
    if isinstance(enabled_raw, bool):
        enabled = enabled_raw
    elif enabled_raw is None:
        enabled = base.ai_enabled
    else:
        enabled = str(enabled_raw).strip().lower() in {"1", "true", "yes", "on"}

    return AiSettings(
        enabled=enabled,
        base_url=_clean(stored.get("base_url")) or base.ai_base_url,
        api_key=_clean(stored.get("api_key")) or base.ai_api_key,
        model=_clean(stored.get("model")) or base.ai_model,
        source="settings 表",
    )


def _parse_json(value):
    """把 settings.value 解析成 dict。

    `value` 是 **text** 不是 jsonb (见 0001_init.sql: 那张表同时存标量和 AI 配置
    的 JSON 串), 所以正常路径拿到的是字符串。这里仍然先判 dict, 是因为
    PostgREST 若哪天把该列改成 jsonb, 行为不该跟着变 —— 调用方已经拿到对象时
    再 json.loads 一次会炸。

    坏数据当"没有"处理, 不抛错: 控制端写入前会 JSON.stringify, 但这一行允许人
    工改, 手改坏了一行配置不该让整个 worker 起不来。"""
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _clean(value) -> str | None:
    text = str(value or "").strip()
    return text or None

