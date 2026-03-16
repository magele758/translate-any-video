#!/bin/bash
# 按 conda 指南启动模型服务
cd "$(dirname "$0")"
echo "启动服务 (http://localhost:8765)..."
echo "模型首次加载约 1-2 分钟，请耐心等待 'Model warmup completed'"
conda run -n asr-translate python main.py
