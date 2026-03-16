# 视频音频实时英译中

**[English](README.md)**

Chrome 插件 + 本地 Python 后端，将视频中的英文语音实时转为中文字幕。全部在本地运行，数据不出设备。

## 环境要求

- macOS (Apple Silicon 推荐)
- Python 3.11+
- Chrome 浏览器
- ffmpeg（conda 会安装）

## 快速开始

### 1. 创建 conda 环境并安装依赖

```bash
cd server
conda env create -f env.yaml
conda activate asr-translate
pip install -r requirements.txt
```

首次运行会下载 Whisper base 模型和 argos-translate 英中语言包，需联网。

**预下载（推荐）**：模型会下载到 `server/models/` 目录：
```bash
cd server
conda activate asr-translate
# 国内用户用镜像加速
HF_ENDPOINT=https://hf-mirror.com python download_models.py
# 或直接下载
python download_models.py
```

**加速**：`export HF_TOKEN=your_token` 或 `HF_ENDPOINT=https://hf-mirror.com`（国内镜像）

### 2. 启动本地服务

```bash
cd server
conda activate asr-translate
python main.py
```

或使用脚本：`./server/start.sh`

服务监听 `http://0.0.0.0:8765`，WebSocket 端点 `ws://localhost:8765/ws`。
**首次启动模型加载约 1-2 分钟**，终端出现 `Model warmup completed` 后即可使用。可用 `curl http://localhost:8765/health` 检查状态。

### 3. 安装 Chrome 插件

1. 打开 Chrome → 扩展程序 → 管理扩展程序
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择项目中的 `extension` 目录

### 4. 使用

1. 打开含英文视频的页面（如 YouTube、B 站）
2. 点击插件图标，确认服务地址为 `ws://localhost:8765/ws`
3. 点击「开始」，播放视频
4. 中文字幕会叠加在视频下方

## 项目结构

```
├── extension/          # Chrome 插件
│   ├── manifest.json
│   ├── popup/          # 弹窗配置
│   └── content/        # 内容脚本（采集、展示）
├── server/             # Python 后端
│   ├── main.py         # FastAPI + WebSocket
│   ├── asr.py          # Whisper ASR
│   ├── translate.py    # argos-translate 英译中
│   └── requirements.txt
└── README.md
```

## 配置说明

- **服务地址**：默认 `ws://localhost:8765/ws`，可改为其他机器
- **字号**：16/18/20/24px
- **位置**：底部居中 / 顶部居中

## DRM 视频（如 Netflix）

`captureStream()` 对 DRM 内容可能失效。可尝试在弹窗中选择「共享标签页」模式（需修改代码支持），或使用无 DRM 的视频源。

## 验证管道（Phase 1 测试）

```bash
conda activate asr-translate
cd server
python test_pipeline.py              # 静音测试
python test_pipeline.py your.wav     # 用 WAV 文件测试
```
