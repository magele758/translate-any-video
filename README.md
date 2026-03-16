# Translate Any Video

A Chrome extension + local Python backend that transcribes English speech from videos in real time and displays Chinese subtitles. Everything runs locally—no data leaves your device.

**[中文文档](README.zh.md)**

## Requirements

- macOS (Apple Silicon recommended)
- Python 3.11+
- Chrome browser
- ffmpeg (installed via conda)

## Quick Start

### 1. Create conda environment and install dependencies

```bash
cd server
conda env create -f env.yaml
conda activate asr-translate
pip install -r requirements.txt
```

First run will download the Whisper base model and argos-translate en→zh language pack (requires internet).

**Pre-download (recommended)** — models go to `server/models/`:
```bash
cd server
conda activate asr-translate
# For users in China, use mirror for faster download
HF_ENDPOINT=https://hf-mirror.com python download_models.py
# Or download directly
python download_models.py
```

**Acceleration**: `export HF_TOKEN=your_token` or `HF_ENDPOINT=https://hf-mirror.com` (China mirror)

### 2. Start the local server

```bash
cd server
conda activate asr-translate
python main.py
```

Or use the script: `./server/start.sh`

Server listens on `http://0.0.0.0:8765`, WebSocket at `ws://localhost:8765/ws`.
**First startup takes ~1–2 minutes** for model loading. Use `curl http://localhost:8765/health` to check status.

### 3. Install the Chrome extension

1. Open Chrome → Extensions → Manage extensions
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension` folder in this project

### 4. Usage

1. Open a page with an English video (e.g. YouTube, Bilibili)
2. Click the extension icon, confirm server URL is `ws://localhost:8765/ws`
3. Click "Start", then play the video
4. Chinese subtitles appear overlaid on the video

## Project structure

```
├── extension/          # Chrome extension
│   ├── manifest.json
│   ├── popup/          # Popup UI
│   └── content/        # Content script (capture, display)
├── server/             # Python backend
│   ├── main.py         # FastAPI + WebSocket
│   ├── asr.py          # Whisper ASR
│   ├── translate.py    # argos-translate en→zh
│   └── requirements.txt
└── README.md
```

## Configuration

- **Server URL**: Default `ws://localhost:8765/ws`, can point to another machine
- **Font size**: 16/18/20/24px
- **Position**: Bottom center / Top center

## DRM videos (e.g. Netflix)

`captureStream()` may fail on DRM content. Try non-DRM video sources instead.

## Pipeline test

```bash
conda activate asr-translate
cd server
python test_pipeline.py              # Silent test
python test_pipeline.py your.wav    # Test with WAV file
```
