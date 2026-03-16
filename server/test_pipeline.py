"""Phase 1 验证：麦克风/文件 -> Whisper -> 翻译 -> 输出"""
import sys
from pathlib import Path

import numpy as np

from asr import ASREngine
from translate import Translator


def test_with_silence():
    """用静音测试管道（无真实语音，仅验证流程）"""
    print("加载模型...")
    asr = ASREngine(model_size="tiny")
    trans = Translator()
    # 1 秒静音
    audio = np.zeros(16000, dtype=np.float32)
    en = asr.transcribe_audio(audio)
    print("ASR 输出:", repr(en))
    zh = trans.translate("Hello world")
    print("翻译测试:", zh)
    print("Pipeline OK")


def test_with_file(wav_path: str):
    """用 WAV 文件测试"""
    try:
        from pydub import AudioSegment
    except ImportError:
        print("需要 pydub: pip install pydub")
        return
    seg = AudioSegment.from_file(wav_path)
    seg = seg.set_channels(1).set_frame_rate(16000)
    samples = np.array(seg.get_array_of_samples(), dtype=np.float32) / 32768.0
    asr = ASREngine(model_size="base")
    trans = Translator()
    en = asr.transcribe_audio(samples)
    print("ASR:", en)
    if en.strip():
        zh = trans.translate(en)
        print("中文:", zh)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        test_with_file(sys.argv[1])
    else:
        test_with_silence()
