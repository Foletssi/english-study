from __future__ import annotations

import json
import os
import subprocess
import wave
from pathlib import Path
from typing import Callable


class MediaError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _run(args: list[str], timeout: int = 7200) -> bytes:
    try:
        completed = subprocess.run(args, capture_output=True, timeout=timeout, check=True)
        return completed.stdout
    except FileNotFoundError as error:
        raise MediaError("FFMPEG_NOT_FOUND", "ffmpeg/ffprobe 不在 PATH 中") from error
    except subprocess.TimeoutExpired as error:
        raise MediaError("MEDIA_TIMEOUT", "媒体处理超时") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or b"").decode("utf-8", "replace")[-1000:]
        raise MediaError("MEDIA_COMMAND_FAILED", detail or "ffmpeg 执行失败") from error


def probe(source: Path) -> dict:
    try:
        data = json.loads(_run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(source)], 60))
        video = next(item for item in data["streams"] if item.get("codec_type") == "video")
        if not any(item.get("codec_type") == "audio" for item in data["streams"]):
            raise MediaError("NO_AUDIO_TRACK", "视频没有音轨")
        duration = float(data.get("format", {}).get("duration", 0))
        if duration <= 0 or duration > 7200:
            raise MediaError("VIDEO_DURATION_INVALID", "视频时长必须在 2 小时以内")
        return {"duration": duration, "width": int(video["width"]), "height": int(video["height"]),
                "fps": video.get("avg_frame_rate", "30/1")}
    except (KeyError, StopIteration, ValueError, TypeError) as error:
        raise MediaError("MEDIA_PROBE_INVALID", "ffprobe 返回的数据无效") from error


def extract_audio(source: Path, target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists() or target.stat().st_size == 0:
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(source),
              "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target)])
    try:
        with wave.open(str(target), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
                raise MediaError("AUDIO_INVALID", "音频不是 16kHz 单声道 PCM")
    except (wave.Error, OSError) as error:
        raise MediaError("AUDIO_INVALID", "音频产物无效") from error
    return target


def transcode_hls(source: Path, output: Path, info: dict, progress: Callable[[int], None] | None = None) -> None:
    output.mkdir(parents=True, exist_ok=True)
    variant = output / "540p"
    variant.mkdir(exist_ok=True)
    playlist = variant / "index.m3u8"
    valid_existing = playlist.exists() and "#EXT-X-ENDLIST" in playlist.read_text(encoding="utf-8", errors="ignore")
    if valid_existing:
        entries = [line.strip() for line in playlist.read_text(encoding="utf-8", errors="ignore").splitlines()
                   if line.strip() and not line.startswith("#")]
        valid_existing = bool(entries) and all((variant / item).is_file() and (variant / item).stat().st_size > 0 for item in entries)
    if not valid_existing:
        width, height = info["width"], info["height"]
        scale = min(1.0, 540 / min(width, height), 960 / max(width, height))
        w, h = max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(source),
              "-map", "0:v:0", "-map", "0:a:0", "-vf", f"scale={w}:{h}:flags=lanczos,setsar=1",
              "-c:v", "libx264", "-preset", "medium", "-crf", "25", "-maxrate", "800k", "-bufsize", "1600k",
              "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-ac", "2", "-f", "hls", "-hls_time", "4",
              "-hls_playlist_type", "vod", "-hls_flags", "independent_segments", "-hls_list_size", "0",
              "-hls_segment_filename", str(variant / "segment_%05d.ts"), str(playlist)])
    master = output / "master.m3u8"
    master.write_text("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=896000,RESOLUTION=960x540\n540p/index.m3u8\n", encoding="utf-8")
    if progress:
        progress(100)


def make_cover(source: Path, target: Path, duration: float, input_path: Path | None = None) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        selected = input_path or source
        seek = [] if input_path else ["-ss", str(max(.1, duration * .25))]
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *seek,
              "-i", str(selected), "-frames:v", "1", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
              "-c:v", "libwebp", "-quality", "85", str(target)], 120)
    return target


def transcribe(audio: Path, video_id: str, duration: float, model_name: str, device: str, compute: str) -> list[dict]:
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise MediaError("ASR_NOT_INSTALLED", "请安装 faster-whisper 并准备模型") from error
    try:
        model = WhisperModel(model_name, device=device, compute_type=compute, local_files_only=True)
        segments, _ = model.transcribe(str(audio), language="en", vad_filter=True, word_timestamps=True, beam_size=5)
        rows = []
        for index, segment in enumerate(segments):
            text = segment.text.strip()
            if not text:
                continue
            words = [{"text": w.word.strip(), "word": w.word.strip().lower(), "start": float(w.start), "end": float(w.end)}
                     for w in (segment.words or []) if w.start is not None and w.end is not None]
            rows.append({"id": f"{video_id}-{index + 1}", "order": index, "startTime": float(segment.start),
                         "endTime": float(segment.end), "english": text, "wordTimings": words})
        if not rows:
            raise MediaError("ASR_EMPTY", "没有识别到英文字幕")
        return rows
    except MediaError:
        raise
    except Exception as error:
        raise MediaError("ASR_FAILED", f"语音识别失败: {error}") from error
