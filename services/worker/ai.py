"""AI 段: 调 OpenAI 兼容接口, 把 ASR 结果做成播放器能渲染的字幕。

-----------------------------------------------------------------------------
这个文件里最要紧的一件事: 产出的形状必须**正好**是播放器读的那个

播放器读的是 `sentence.tokens[]`, 每个 token 是
`{ text, key, level, id, gloss }`
(src/ui/player.js:459, :569)。它**不看** `sentence.words`。

之前的版本产的是 `{"words": [{"text":…, "meaning":…}]}` —— 名字对不上, 而且
即便如此也还不够: `key`(是否重点词) 和 `level`(1/2 难度分级) 在旧输出里**没有
任何来源**, 它把所有词塞进一个数组, 没有区分。结果是播放器里 `sentence.tokens`
恒为 undefined, 回落到"整句当一个 token", 于是每个词都点不动、词卡永远打不开、
重点词计数恒为 0 —— 而且因为那个 `||` 兜底, 页面上看不出任何异常。

所以这里的映射是两步模型的粘合层, 不是字段改名:

    1. transcribe (prompts.json#transcribe) —— 出 text / translation / key_tokens
    2. enrich     (prompts.json#enrich)     —— 出学习卡片, 带 gloss / phonetic / tag
    3. 本文件把卡片按 sentence_index 贴回句子, 再把**句子里每一个词**展开成
       token; 命中 key_tokens 或卡片 word 的标 key=true 并挂上卡片内容。

"每个词都展开"是刻意的: 学员点任何一个词都该有反应, 重点词只是**额外**有
释义和配色。旧版只挂了重点词, 于是非重点词点了没反应, 看起来像坏了。

-----------------------------------------------------------------------------
指令从 prompts/prompts.json 读, 不在这里写

见 services/worker/prompts.py 的文件头。版本号会随结果一起写库。
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from .prompts import prompt_text, prompt_version


class AIError(RuntimeError):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


#: 一次请求最多带多少句。字幕可能几千句, 一次性发过去会撞上下文上限 —— 而
#: 撞上限的表现是上游回 400, 整条流水线失败在一个跟内容无关的原因上。
BATCH_SIZE = 40

#: 单次上游调用的超时。180 秒对一批 40 句是够的; 上游真的慢到这个数, 重试
#: 也不会更快, 应该让这一步失败并把原因写进 error_message。
TIMEOUT_SECONDS = 180

#: 每句最多认定几个重点词。指令里写了 0-3, 这里是服务端的兜底 —— 模型偶尔
#: 会返回一整句, 那样重点词高亮会糊成一片, 计数也失去意义。
MAX_KEY_TOKENS = 3


def _endpoint(base_url: str) -> str:
    trimmed = base_url.rstrip("/")
    if trimmed.endswith("/chat/completions"):
        return trimmed
    return f"{trimmed}/chat/completions"


def _post(base_url: str, api_key: str, model: str, system: str, user: dict, *, temperature: float) -> dict:
    """一次 JSON 模式的对话调用。返回解析后的对象 (不是原始文本)。"""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": temperature,
    }
    request = urllib.request.Request(
        _endpoint(base_url),
        data=json.dumps(payload, ensure_ascii=False).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            raw = json.loads(response.read())
    except urllib.error.HTTPError as error:
        # 上游的错误正文里常常带 key 或者完整请求回显, 只取状态码和一行摘要,
        # 不让它进日志/进 processing_jobs.error_message。
        detail = error.read().decode("utf-8", "replace")[:200]
        raise AIError("AI_HTTP_ERROR", f"上游返回 {error.code}: {detail}") from error
    except Exception as error:
        raise AIError("AI_REQUEST_FAILED", f"调用失败: {error}") from error

    try:
        content = raw["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise AIError("AI_BAD_RESPONSE", "上游响应里没有 choices[0].message.content") from error

    if isinstance(content, dict):
        return content
    try:
        parsed = json.loads(content)
    except (TypeError, ValueError) as error:
        raise AIError("AI_BAD_JSON", "模型返回的不是合法 JSON") from error
    if not isinstance(parsed, dict):
        raise AIError("AI_BAD_JSON", "模型返回的 JSON 顶层不是对象")
    return parsed


def _batches(rows: list[dict], size: int):
    for start in range(0, len(rows), size):
        yield rows[start:start + size]


# ---------------------------------------------------------------------------
# 第一步: 转写校对 + 翻译 + 重点词
# ---------------------------------------------------------------------------

def _transcribe_batch(rows: list[dict], base_url: str, api_key: str, model: str) -> dict[str, dict]:
    """返回 {原始 id: {text, translation, key_tokens}}。"""
    system = prompt_text("transcribe")
    # 只发必要字段。把 wordTimings 一起发过去会让请求体大好几倍, 而模型用不到
    # 逐词时间戳 —— 它要判断的是"这句话里哪个词值得教"。
    user = {"sentences": [{"id": r["id"], "english": r["english"]} for r in rows]}
    result = _post(base_url, api_key, model, system, user, temperature=0.2)

    out: dict[str, dict] = {}
    for item in result.get("sentences", []) or []:
        if not isinstance(item, dict):
            continue
        ident = str(item.get("id", ""))
        if not ident:
            continue
        keys = item.get("key_tokens")
        out[ident] = {
            "text": str(item.get("text") or "").strip(),
            "translation": str(item.get("translation") or "").strip(),
            "key_tokens": [str(k).strip() for k in (keys if isinstance(keys, list) else []) if str(k).strip()][:MAX_KEY_TOKENS],
        }
    return out


# ---------------------------------------------------------------------------
# 第二步: 学习卡片
# ---------------------------------------------------------------------------

def _enrich_batch(rows: list[dict], base_url: str, api_key: str, model: str, index_of: dict[str, int]) -> list[dict]:
    """返回卡片列表。`index_of` 把原始 id 映射到句子序号 —— 卡片带的是
    sentence_index, 也就是这个序号, 贴回去的时候靠它。"""
    system = prompt_text("enrich")
    user = {
        "sentences": [
            {"index": index_of[r["id"]], "text": r["english"]}
            for r in rows if r["id"] in index_of
        ],
    }
    result = _post(base_url, api_key, model, system, user, temperature=0.3)

    cards = []
    for item in result.get("cards", []) or []:
        if not isinstance(item, dict):
            continue
        word = str(item.get("word") or "").strip()
        if not word:
            continue
        sentence_index = item.get("sentence_index")
        cards.append({
            "word": word,
            "lemma": str(item.get("lemma") or word).strip(),
            "phonetic": str(item.get("phonetic") or "").strip(),
            "tag": str(item.get("tag") or "").strip(),
            "gloss": str(item.get("gloss") or "").strip(),
            "context": str(item.get("context") or "").strip(),
            "example": str(item.get("example") or "").strip(),
            "example_translation": str(item.get("example_translation") or "").strip(),
            "sentence_index": int(sentence_index) if isinstance(sentence_index, (int, float)) else None,
        })
    return cards


# ---------------------------------------------------------------------------
# 把卡片和重点词合进句子, 产出行播放器要的 tokens
# ---------------------------------------------------------------------------

#: 切词。保留撇号 (don't) 和连字符 (pick-me-up), 其余按非字母切。
#: `\w` 在 Python 的 re 里默认匹配 Unicode 字母, 但这里是英文语料, 用显式的
#: ASCII 范围更可控 —— 中文字幕走不到这条路径, 但标点混进来不会切出怪结果。
_WORD = re.compile(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*")


def _normalize(value: str) -> str:
    return value.strip().lower().strip(".,!?;:\"'")


def build_tokens(text: str, key_tokens: list[str], card_by_word: dict[str, dict]) -> list[dict]:
    """把一句英文展开成 token 列表。

    重点词的判定按**短语优先**: key_tokens 里可能有 "pick up" 这种两词搭配,
    逐词匹配是匹配不到的。所以先按短语长度从长到短扫, 命中的位置整段标 key;
    剩下没被短语覆盖的词, 再单独看它是不是某张卡片的 word。"""
    if not text:
        return []

    matches = list(_WORD.finditer(text))
    if not matches:
        return []

    keyed: dict[int, dict] = {}          # token 下标 -> 卡片 (可能为空字典)
    covered: list[bool] = [False] * len(matches)

    # 短语匹配: 长短语先扫, 扫到就把覆盖范围内的 token 标记掉, 避免
    # "pick up" 和里面的 "pick" 同时命中, 出现重复标注。
    phrases = sorted({_normalize(k) for k in key_tokens if " " in _normalize(k)}, key=len, reverse=True)
    words_index = {_normalize(m.group()): i for i, m in enumerate(matches)}

    for phrase in phrases:
        parts = phrase.split()
        if not parts:
            continue
        for start in range(len(matches) - len(parts) + 1):
            if any(covered[start + offset] for offset in range(len(parts))):
                continue
            if all(_normalize(matches[start + offset].group()) == parts[offset] for offset in range(len(parts))):
                for offset in range(len(parts)):
                    covered[start + offset] = True
                # 整段第一个 token 挂卡片, 其余同段 token 也标 key (但没有独立释义)
                card = card_by_word.get(phrase, {})
                keyed[start] = card
                for offset in range(1, len(parts)):
                    keyed[start + offset] = {}

    # 单词匹配: 先看 key_tokens 里的单词, 再看卡片表。
    single_keys = {_normalize(k) for k in key_tokens if " " not in _normalize(k)}
    for index, match in enumerate(matches):
        if covered[index] or index in keyed:
            continue
        lowered = _normalize(match.group())
        if lowered in single_keys or lowered in card_by_word:
            keyed[index] = card_by_word.get(lowered, {})

    # 超过上限就把多出来的降级为普通词 —— 宁可少标, 不要让整句都变重点色。
    if len(keyed) > MAX_KEY_TOKENS:
        for index in sorted(keyed)[MAX_KEY_TOKENS:]:
            keyed.pop(index, None)

    tokens = []
    for index, match in enumerate(matches):
        is_key = index in keyed
        card = keyed.get(index) or {}
        tokens.append({
            "text": match.group(),
            "key": is_key,
            # level 只在有卡片时给 1 —— 配色方案只有 level-1 / level-2 两档,
            # 重点词里"有完整释义的"标 1, 其余保持无色。没有卡片信息的重点词
            # (短语里的第二、三个词) 不给 level, 免得看起来像有释义却点开是空的。
            "level": 1 if card else None,
            # id 决定这个词能不能点 (player.js:465: `on: token.id ? …`)。所有
            # 词都给 id, 这样非重点词点下去也有反应 —— 词卡会显示这个词本身,
            # 只是没有释义。点了没反应比"没有释义"更像坏了。
            "id": f"{index}",
            "gloss": card.get("gloss") or None,
            "phonetic": card.get("phonetic") or None,
            "tag": card.get("tag") or None,
            "lemma": card.get("lemma") or match.group(),
            "context": card.get("context") or None,
            "example": card.get("example") or None,
            "example_translation": card.get("example_translation") or None,
        })
    return tokens


def _tokens_without_ai(rows: list[dict]) -> list[dict]:
    """AI 关掉时用的降级产出: 只有原文, 没有翻译和释义。

    仍然要切出 tokens —— 不然播放器连"点词"都做不到, 而这一步没有 AI 也完全
    做得到。翻译留空, 前端渲染时会跳过空的翻译行。"""
    return [
        {
            "index": row["order"],
            "start": row["startTime"],
            "end": row["endTime"],
            "text": row["english"],
            "translation": None,
            "tokens": build_tokens(row["english"], [], {}),
        }
        for row in rows
    ]


def enrich_subtitles(rows: list[dict], base_url: str | None, api_key: str | None, model: str | None, *, enabled: bool = True) -> list[dict]:
    """把 ASR 结果做成字幕。这是 worker AI 段的唯一入口。

    `enabled=False` 时**不调用上游**, 直接返回降级结果。这个开关以前在 worker
    侧根本没被读过 —— 控制端关掉它, 流水线照样调 AI, 关掉等于没关。

    配置不全但 enabled=True 时抛 `AI_NOT_CONFIGURED`, 让 job 失败并把这个原因
    写进 error_message。这是对的: 运维以为开着, 实际没配, 静默降级会让他以为
    AI 跑了但效果不好。
    """
    if not enabled:
        return _tokens_without_ai(rows)

    if not base_url or not api_key or not model:
        raise AIError("AI_NOT_CONFIGURED", "AI 已开启但缺少地址/密钥/模型")

    index_of = {row["id"]: row["order"] for row in rows}

    # 第一步: 逐批转写校对 + 翻译 + 重点词
    polished: dict[str, dict] = {}
    for batch in _batches(rows, BATCH_SIZE):
        polished.update(_transcribe_batch(batch, base_url, api_key, model))

    # 第二步: 逐批生成卡片
    cards: list[dict] = []
    for batch in _batches(rows, BATCH_SIZE):
        cards.extend(_enrich_batch(batch, base_url, api_key, model, index_of))

    # 卡片按 sentence_index 归位; 同时按 word 建索引给 build_tokens 用
    cards_by_sentence: dict[int, dict[str, dict]] = {}
    for card in cards:
        sentence_index = card.get("sentence_index")
        if sentence_index is None:
            continue
        bucket = cards_by_sentence.setdefault(sentence_index, {})
        # 同一句里同一个词只留第一张 —— 重复卡片会让一个 token 挂两次释义。
        bucket.setdefault(_normalize(card["word"]), card)

    subtitles = []
    for row in rows:
        item = polished.get(row["id"], {})
        # 校对后的 text 是权威的 —— 但只在它非空时用。模型偶尔会漏掉某一句,
        # 那一句就退回 ASR 原文, 而不是变成空白字幕。
        text = item.get("text") or row["english"]
        subtitles.append({
            "index": row["order"],
            "start": row["startTime"],
            "end": row["endTime"],
            "text": text,
            "translation": item.get("translation") or None,
            "tokens": build_tokens(
                text,
                item.get("key_tokens") or [],
                cards_by_sentence.get(row["order"], {}),
            ),
        })
    return subtitles


def stamp(subtitles: list[dict]) -> list[dict]:
    """把提示词版本写进结果。一条教学材料质量不对时, 要能查到它是哪一版指令
    产出的 —— 不然只能靠时间猜。"""
    version = prompt_version()
    for sentence in subtitles:
        sentence["prompt_version"] = version
    return subtitles
