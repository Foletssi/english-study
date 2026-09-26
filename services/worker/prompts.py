"""AI 指令 (提示词) 的读取器 —— 读的是 JS 侧同一份 `prompts/prompts.json`。

-----------------------------------------------------------------------------
为什么不是把指令抄到这个文件里

控制端的设置页会把每条指令的正文展示给运维看 —— 那是"证据", 他对着它判断
一条教学材料为什么好或不好。如果 Python 侧另存一份, 两份迟早会分家, 而分家
之后控制台展示的那份就变成了装饰: 运维对着 A 版判断, 模型跑的是 B 版, 两边
都是合理的中文文本, 没有任何一处会报错。所以只有一份真源。

`src/admin/prompts.js` 读同一个文件 (esbuild 把它打进控制端 bundle), 版本号
是两边的契约。

-----------------------------------------------------------------------------
找不到文件时**抛错**, 不静默回退

一个空的提示词比一个错误的提示词更危险: 模型收到空 system 消息之后会自由发挥,
产出的 JSON 结构仍然是合法的, 于是流水线一路跑到发布, 学员看到的是没有重点词、
释义乱写的字幕 —— 而日志里一个错都没有。

所以文件缺失 / JSON 坏掉 / 缺 id 都在**加载时**抛错, worker 起不来。宁可让它
起不来, 也不要让它带着空指令跑。

-----------------------------------------------------------------------------
路径怎么找

默认是 `services/worker/prompts.py` 往上三层再加 `prompts/prompts.json`, 也就是
仓库根。worker 是 `python -m services.worker.worker` 起的, 工作目录是仓库根,
但这个默认值不依赖工作目录 —— 它按 `__file__` 算, 所以从任何地方启动都能找到。

`PROMPTS_FILE` 环境变量可以覆盖, 给"worker 与仓库不同机部署"的情况留一个口子。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

#: 四个 id。worker 用到的是 transcribe / enrich / audit 三条; preraw 是原片
#: 入库阶段的方案指令, 目前由控制端展示, worker 侧先不调 —— 但这里仍然要求
#: 它存在, 因为"四条都在"是这份文件的契约, 缺一条就该当场发现。
REQUIRED_IDS = ("preraw", "transcribe", "enrich", "audit")

DEFAULT_PROMPTS_FILE = Path(__file__).resolve().parents[2] / "prompts" / "prompts.json"


class PromptError(RuntimeError):
    """提示词不可用。带上 code 是为了让 processing_jobs.error_code 能落到
    一个可检索的值上, 而不是一长串中文。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def prompts_path() -> Path:
    override = os.getenv("PROMPTS_FILE", "").strip()
    return Path(override).resolve() if override else DEFAULT_PROMPTS_FILE


def load_prompts(path: Path | None = None) -> dict[str, Any]:
    """读整份提示词文件。校验到"能被调用"为止, 然后原样返回。"""
    target = path or prompts_path()

    try:
        raw = target.read_text("utf-8")
    except FileNotFoundError as error:
        raise PromptError("PROMPTS_FILE_MISSING", f"找不到提示词文件: {target}") from error
    except OSError as error:
        raise PromptError("PROMPTS_FILE_UNREADABLE", f"提示词文件读不出来: {target} ({error})") from error

    try:
        data = json.loads(raw)
    except ValueError as error:
        raise PromptError("PROMPTS_MALFORMED", f"提示词文件不是合法 JSON: {target} ({error})") from error

    if not isinstance(data, dict):
        raise PromptError("PROMPTS_MALFORMED", "提示词文件的顶层必须是一个对象")

    version = data.get("version")
    if not isinstance(version, str) or not version.strip():
        raise PromptError("PROMPTS_NO_VERSION", "提示词文件缺少 version")

    items = data.get("prompts")
    if not isinstance(items, list) or not items:
        raise PromptError("PROMPTS_EMPTY", "提示词文件的 prompts 是空的")

    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise PromptError("PROMPTS_MALFORMED", "prompts 数组里有一项不是对象")
        ident = item.get("id")
        if not isinstance(ident, str) or not ident:
            raise PromptError("PROMPTS_MALFORMED", "有一条提示词缺少 id")
        if ident in seen:
            raise PromptError("PROMPTS_DUPLICATE_ID", f"提示词 id 重复: {ident}")
        seen.add(ident)
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            raise PromptError("PROMPTS_EMPTY_TEXT", f"提示词 {ident} 的正文是空的")

    missing = [ident for ident in REQUIRED_IDS if ident not in seen]
    if missing:
        raise PromptError("PROMPTS_INCOMPLETE", f"提示词文件缺少: {', '.join(missing)}")

    return data


#: 进程内缓存。指令在一次运行里不会变, 每处理一个视频重读一次盘没有意义;
#: 而且读失败是在**启动时**就抛过的, 这里再读到的一定是同一份好数据。
_CACHE: dict[str, Any] | None = None


def prompts() -> dict[str, Any]:
    global _CACHE
    if _CACHE is None:
        _CACHE = load_prompts()
    return _CACHE


def prompt_version() -> str:
    return str(prompts()["version"])


def prompt_text(prompt_id: str) -> str:
    """按 id 取正文。取不到时抛 `PromptError` —— 见文件头"找不到文件时抛错"。

    `load_prompts` 已经保证了四个必需 id 存在, 所以这里走到 missing 分支只有
    一种情况: 代码里写了第五个 id。那也是要当场发现的事。"""
    for item in prompts()["prompts"]:
        if item.get("id") == prompt_id:
            return str(item["text"])
    raise PromptError("PROMPTS_UNKNOWN_ID", f"未知的提示词: {prompt_id}")
