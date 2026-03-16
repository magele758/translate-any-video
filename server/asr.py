"""Whisper ASR 封装 - 英文语音转文字"""
import numpy as np
from faster_whisper import WhisperModel


class ASREngine:
    def __init__(self, model_size: str = "base", device: str = "auto", compute_type: str = "default"):
        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)

    def transcribe_audio(self, audio: np.ndarray, sample_rate: int = 16000) -> str:
        """将音频 numpy 数组转为英文文本"""
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32) / 32768.0
        segments, _ = self.model.transcribe(audio, language="en", vad_filter=True)
        return " ".join(s.text.strip() for s in segments if s.text.strip())

    def transcribe_bytes(self, audio_bytes: bytes, sample_rate: int = 16000) -> str:
        """将原始 PCM 字节转为英文文本"""
        audio = np.frombuffer(audio_bytes, dtype=np.int16)
        audio_float = audio.astype(np.float32) / 32768.0
        return self.transcribe_audio(audio_float, sample_rate)
