#!/usr/bin/env python3
"""预下载模型到当前目录。用法：HF_ENDPOINT=https://hf-mirror.com python download_models.py"""
import os
import sys
from pathlib import Path

# 当前脚本所在目录 = server/
BASE = Path(__file__).resolve().parent
MODELS_DIR = BASE / "models"
WHISPER_DIR = MODELS_DIR / "whisper-base"
ARGOS_DIR = MODELS_DIR / "argos-translate" / "packages"


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    ARGOS_DIR.mkdir(parents=True, exist_ok=True)
    os.environ["ARGOS_PACKAGES_DIR"] = str(ARGOS_DIR)

    print("=" * 50)
    print("预下载模型到:", MODELS_DIR)
    print("=" * 50)
    if os.environ.get("HF_ENDPOINT"):
        print(f"使用镜像: {os.environ['HF_ENDPOINT']}")
    if os.environ.get("HF_TOKEN"):
        print("已检测到 HF_TOKEN")
    print()

    # 1. faster-whisper (约 150MB)
    print("[1/2] 下载 faster-whisper-base ->", WHISPER_DIR)
    try:
        from faster_whisper import utils
        utils.download_model("base", output_dir=str(WHISPER_DIR))
        print("  ASR 模型已就绪")
    except Exception as e:
        print(f"  ASR 下载失败: {e}")
        sys.exit(1)

    # 2. 跳过 Stanza（国内易卡住），改用 MiniSBD 做句子切分
    print("\n[2/3] 跳过 Stanza，将使用 MiniSBD（ARGOS_CHUNK_TYPE=MINISBD）")

    # 3. argos-translate en->zh
    print("\n[3/3] 下载 argos-translate 英中语言包 ->", ARGOS_DIR)
    try:
        from translate import Translator
        Translator()
        print("  翻译模型已就绪")
    except Exception as e:
        print(f"  翻译模型下载失败: {e}")
        sys.exit(1)

    print("\n全部下载完成。")


if __name__ == "__main__":
    main()
