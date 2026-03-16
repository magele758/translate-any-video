"""FastAPI 服务：WebSocket 接收音频，ASR+翻译后返回中文"""
import os
import sys
from pathlib import Path

# 在导入 huggingface 相关库之前设置
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "0")
# 本地模型目录
_BASE = Path(__file__).resolve().parent
_MODELS = _BASE / "models"
_argos_packages = _MODELS / "argos-translate" / "packages"
if _argos_packages.exists():
    os.environ.setdefault("ARGOS_PACKAGES_DIR", str(_argos_packages))
# 使用 MiniSBD 做句子切分，避免 Stanza 在国内下载卡住
os.environ.setdefault("ARGOS_CHUNK_TYPE", "MINISBD")

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import numpy as np
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from scipy import signal

from asr import ASREngine
from translate import Translator

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 全局模型（懒加载）
_asr: ASREngine | None = None
_translator: Translator | None = None
_warmup_task: asyncio.Task | None = None
_warmup_error: str | None = None
_warmup_phase: str = "idle"  # idle | asr | translator | done
_connected_ws: set = set()

# 音频参数
TARGET_SR = 16000
EMIT_STEP_SEC = 0.8
WINDOW_SEC = 3.2
MIN_WINDOW_SEC = 1.6
MAX_BUFFER_SEC = 12.0
SILENCE_FINALIZE_SEC = 1.0
SILENCE_RMS_THRESHOLD = 0.008

EMIT_STEP_SAMPLES = int(TARGET_SR * EMIT_STEP_SEC)
WINDOW_SAMPLES = int(TARGET_SR * WINDOW_SEC)
MIN_WINDOW_SAMPLES = int(TARGET_SR * MIN_WINDOW_SEC)
MAX_BUFFER_SAMPLES = int(TARGET_SR * MAX_BUFFER_SEC)


@dataclass
class StreamState:
    client_sr: int = TARGET_SR
    audio_buffer: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.int16))
    samples_since_emit: int = 0
    silence_duration_sec: float = 0.0
    last_partial_en: str = ""
    last_partial_zh: str = ""
    last_final_en: str = ""
    inference_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=1))


def resample_to_16k(audio_int16: np.ndarray, orig_sr: int) -> np.ndarray:
    if orig_sr <= 0:
        raise ValueError(f"Invalid sample rate: {orig_sr}")
    if orig_sr == TARGET_SR:
        return audio_int16
    audio_float = audio_int16.astype(np.float32) / 32768.0
    num_samples = int(len(audio_float) * TARGET_SR / orig_sr)
    resampled = signal.resample(audio_float, num_samples)
    return (resampled * 32768).astype(np.int16)


def normalize_text(text: str) -> str:
    return " ".join(text.split())


def append_audio(buffer: np.ndarray, chunk: np.ndarray) -> np.ndarray:
    if buffer.size == 0:
        combined = chunk.copy()
    else:
        combined = np.concatenate((buffer, chunk))
    if combined.size > MAX_BUFFER_SAMPLES:
        combined = combined[-MAX_BUFFER_SAMPLES:]
    return combined


def latest_window(buffer: np.ndarray) -> np.ndarray:
    if buffer.size <= WINDOW_SAMPLES:
        return buffer.copy()
    return buffer[-WINDOW_SAMPLES:].copy()


def frame_rms(audio: np.ndarray) -> float:
    if audio.size == 0:
        return 0.0
    audio_float = audio.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(np.square(audio_float))))


def get_asr() -> ASREngine:
    global _asr
    if _asr is None:
        local_path = _MODELS / "whisper-base"
        model_path = str(local_path) if local_path.exists() else "base"
        _asr = ASREngine(model_size=model_path)
    return _asr


def _warmup_translator() -> Translator:
    return get_translator()


def get_translator() -> Translator:
    global _translator
    if _translator is None:
        _translator = Translator()
    return _translator


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _warmup_task
    _warmup_task = asyncio.create_task(warmup_models())
    yield
    if _warmup_task and not _warmup_task.done():
        _warmup_task.cancel()
        try:
            await _warmup_task
        except asyncio.CancelledError:
            pass


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _log_progress_loop(stop_event, phase_ref: list):
    """定期输出下载进度，让用户知道在运行（在线程中执行）"""
    import time
    start = time.time()
    phase_msgs = {"asr": "ASR 模型", "translator": "翻译模型"}
    while not stop_event.wait(timeout=5):
        elapsed = int(time.time() - start)
        phase = phase_ref[0] if phase_ref else "asr"
        msg = phase_msgs.get(phase, "模型")
        sys.stderr.write(f"\r正在下载/加载 {msg}... (已等待 {elapsed} 秒) ")
        sys.stderr.flush()
    sys.stderr.write("\r" + " " * 60 + "\r")
    sys.stderr.flush()


async def warmup_models():
    global _warmup_error, _warmup_phase, _connected_ws
    import threading
    loop = asyncio.get_running_loop()
    progress_stop = threading.Event()
    phase_ref = [_warmup_phase]
    progress_thread = None
    try:
        if sys.stderr.isatty():
            if os.environ.get("HF_TOKEN"):
                logger.info("已检测到 HF_TOKEN，将使用认证加速下载")
            progress_thread = threading.Thread(
                target=_log_progress_loop,
                args=(progress_stop, phase_ref),
                daemon=True,
            )
            progress_thread.start()
        _warmup_phase = "asr"
        phase_ref[0] = "asr"
        logger.info("Loading ASR model... (首次需下载约 150MB)")
        await loop.run_in_executor(None, get_asr)
        _warmup_phase = "translator"
        phase_ref[0] = "translator"
        logger.info("Preparing translator... (首次需加载 Stanza，约 1-2 分钟)")
        await loop.run_in_executor(None, _warmup_translator)
        _warmup_phase = "done"
        phase_ref[0] = "done"
        logger.info("Model warmup completed")
        for w in list(_connected_ws):
            try:
                await w.send_json({"type": "model_ready"})
            except Exception:
                pass
    except Exception as exc:
        _warmup_error = str(exc)
        logger.exception("Model warmup failed: %s", exc)
    finally:
        progress_stop.set()
        if progress_thread and progress_thread.is_alive():
            progress_thread.join(timeout=2)


@app.post("/transcribe")
async def transcribe_batch(audio: UploadFile = File(...)):
    """批量转写：接收完整音频(PCM int16 16kHz)，返回英文字幕+中文翻译"""
    raw = await audio.read()
    if len(raw) < 1000:
        return {"en": "", "zh": "", "error": "音频过短"}
    audio_arr = np.frombuffer(raw, dtype=np.int16)
    if len(audio_arr) < 1600:  # <0.1s
        return {"en": "", "zh": "", "error": "音频过短"}
    loop = asyncio.get_running_loop()
    en_text = await loop.run_in_executor(
        None, lambda: get_asr().transcribe_audio(audio_arr, TARGET_SR)
    )
    en_text = normalize_text(en_text) if en_text else ""
    zh_text = ""
    if en_text:
        zh_text = await loop.run_in_executor(
            None, lambda: get_translator().translate(en_text)
        )
    return {"en": en_text, "zh": zh_text}


TTS_VOICE = "zh-CN-YunxiNeural"  # 中文男声，可改为 zh-CN-XiaoxiaoNeural 等


async def _tts_to_bytes(text: str) -> bytes:
    import edge_tts
    from io import BytesIO
    buf = BytesIO()
    communicate = edge_tts.Communicate(text.strip(), TTS_VOICE, rate="+0%")
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio":
            buf.write(chunk["data"])
    buf.seek(0)
    return buf.read()


@app.get("/tts")
async def tts(text: str = ""):
    """Edge-TTS 中文语音，返回 MP3"""
    if not text or len(text) > 500:
        return Response(content=b"", status_code=400)
    try:
        audio_bytes = await _tts_to_bytes(text)
        return Response(content=audio_bytes, media_type="audio/mpeg")
    except Exception as e:
        logger.exception("TTS error: %s", e)
        return Response(content=b"", status_code=500)


@app.get("/health")
def health():
    if _warmup_error:
        return {"status": "error", "message": _warmup_error}
    if _warmup_task is not None and not _warmup_task.done():
        phase_msg = {"asr": "正在下载/加载 ASR 模型", "translator": "正在加载翻译模型"}.get(
            _warmup_phase, "加载中"
        )
        return {"status": "warming", "phase": _warmup_phase, "message": phase_msg}
    return {"status": "ok"}


async def send_caption(ws: WebSocket, caption_type: str, en_text: str, zh_text: str):
    try:
        await ws.send_json({"type": caption_type, "text": zh_text, "en": en_text})
    except (RuntimeError, Exception) as e:
        if "websocket" in str(e).lower() or "close" in str(e).lower():
            logger.debug("WebSocket 已关闭，跳过发送: %s", e)
        else:
            raise


async def maybe_finalize(ws: WebSocket, state: StreamState):
    if state.last_partial_en and state.last_partial_en != state.last_final_en:
        state.last_final_en = state.last_partial_en
        await send_caption(ws, "final", state.last_partial_en, state.last_partial_zh)
    state.last_partial_en = ""
    state.last_partial_zh = ""


def enqueue_window(state: StreamState):
    window = latest_window(state.audio_buffer)
    if state.inference_queue.full():
        try:
            state.inference_queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
    state.inference_queue.put_nowait(window)


async def inference_worker(ws: WebSocket, state: StreamState):
    loop = asyncio.get_running_loop()

    while True:
        window = await state.inference_queue.get()
        if window is None:
            break

        def _transcribe() -> str:
            return normalize_text(get_asr().transcribe_audio(window, TARGET_SR))

        en_text = await loop.run_in_executor(None, _transcribe)
        if not en_text:
            continue
        if en_text == state.last_partial_en or en_text == state.last_final_en:
            continue

        zh_text = await loop.run_in_executor(None, lambda t=en_text: get_translator().translate(t))
        state.last_partial_en = en_text
        state.last_partial_zh = zh_text
        await send_caption(ws, "partial", en_text, zh_text)
        logger.info("partial en: %s -> zh: %s", en_text[:50], zh_text[:50])


async def handle_text_message(ws: WebSocket, state: StreamState, text: str):
    payload = json.loads(text)
    if payload.get("type") != "config":
        return

    sample_rate = int(payload.get("sampleRate", TARGET_SR))
    if sample_rate <= 0:
        raise ValueError(f"Invalid sample rate from client: {sample_rate}")

    state.client_sr = sample_rate
    await ws.send_json(
        {"type": "ready", "sampleRate": state.client_sr, "targetSampleRate": TARGET_SR}
    )


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    _connected_ws.add(ws)
    state = StreamState()
    worker = asyncio.create_task(inference_worker(ws, state))

    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect()

            text = message.get("text")
            if text is not None:
                await handle_text_message(ws, state, text)
                continue

            chunk_bytes = message.get("bytes")
            if chunk_bytes is None:
                continue

            audio = np.frombuffer(chunk_bytes, dtype=np.int16)
            if audio.size == 0:
                continue
            if state.client_sr != TARGET_SR:
                audio = resample_to_16k(audio, state.client_sr)

            state.audio_buffer = append_audio(state.audio_buffer, audio)
            state.samples_since_emit += audio.size

            duration_sec = audio.size / TARGET_SR
            if frame_rms(audio) < SILENCE_RMS_THRESHOLD:
                state.silence_duration_sec += duration_sec
            else:
                state.silence_duration_sec = 0.0

            if (
                state.audio_buffer.size >= MIN_WINDOW_SAMPLES
                and state.samples_since_emit >= EMIT_STEP_SAMPLES
            ):
                enqueue_window(state)
                state.samples_since_emit = 0

            if state.silence_duration_sec >= SILENCE_FINALIZE_SEC:
                await maybe_finalize(ws, state)
                state.silence_duration_sec = 0.0

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.exception("WebSocket error: %s", e)
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        _connected_ws.discard(ws)
        try:
            await maybe_finalize(ws, state)
        except Exception:
            pass
        try:
            if state.inference_queue.full():
                try:
                    state.inference_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            state.inference_queue.put_nowait(None)
        except Exception:
            pass
        await worker
        try:
            await ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
