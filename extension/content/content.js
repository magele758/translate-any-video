/* 视频音频英译中 - Content Script */

const SAMPLE_RATE = 16000;
const CHUNK_MS = 250;

let ws = null;
let overlay = null;
let overlayConfig = { fontSize: "18", position: "bottom", showSubtitle: true, ttsEnabled: false };
let ttsQueue = [];
let ttsPlaying = false;
let stableSubtitle = "";
let pendingSubtitle = "";
let stopCaptureFn = null;
let accumulatedChunks = [];
let isCapturing = false;
let mode = "realtime"; // "realtime" | "batch"

function applyOverlayStyle() {
  if (!overlay) return;
  overlay.style.fontSize = overlayConfig.fontSize + "px";
  overlay.style.bottom = overlayConfig.position === "bottom" ? "60px" : "auto";
  overlay.style.top = overlayConfig.position === "top" ? "60px" : "auto";
}

function ensureOverlay() {
  if (overlay) {
    applyOverlayStyle();
    return overlay;
  }
  overlay = document.createElement("div");
  overlay.id = "asr-translate-overlay";
  overlay.className = "hidden";
  document.body.appendChild(overlay);
  applyOverlayStyle();
  return overlay;
}

function showSubtitle(text, isError = false) {
  if (!overlayConfig.showSubtitle && !isError) return;
  const el = ensureOverlay();
  el.textContent = text;
  el.classList.remove("hidden", "transcript-content");
  el.classList.toggle("error", isError);
}

function showTranscript(en, zh) {
  const el = ensureOverlay();
  el.classList.add("transcript-content");
  el.innerHTML = "";
  if (zh) {
    const p = document.createElement("p");
    p.className = "zh";
    p.textContent = zh;
    el.appendChild(p);
  }
  if (en) {
    const p = document.createElement("p");
    p.className = "en";
    p.textContent = en;
    el.appendChild(p);
  }
  el.classList.remove("hidden");
}

function hideOverlay() {
  if (overlay) overlay.classList.add("hidden");
}

function resetSubtitleState() {
  stableSubtitle = "";
  pendingSubtitle = "";
}

let _ttsCtx = null;

function getTtsCtx() {
  if (_ttsCtx && _ttsCtx.state !== "closed") return _ttsCtx;
  _ttsCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _ttsCtx;
}

function unlockAudio() {
  if (window._ttsUnlocked) return;
  try {
    const ctx = getTtsCtx();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    window._ttsUnlocked = true;
  } catch (_) {}
}

async function playEdgeTTS(text, baseUrl) {
  if (!text || !baseUrl) return;
  ttsPlaying = true;
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "tts", text, baseUrl }, resolve);
    });
    if (!res?.ok || !res.audio) {
      ttsPlaying = false;
      return playNextTTS();
    }
    const ctx = getTtsCtx();
    if (ctx.state === "suspended") await ctx.resume();
    const blob = new Blob([res.audio], { type: "audio/mpeg" });
    const arrayBuf = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuf);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    src.onended = () => {
      ttsPlaying = false;
      playNextTTS();
    };
    src.start(0);
  } catch (_) {
    ttsPlaying = false;
    playNextTTS();
  }
}

function playNextTTS() {
  if (ttsQueue.length === 0) {
    ttsPlaying = false;
    return;
  }
  if (ttsPlaying) return;  // 必须等当前播完，onended 会再调 playNextTTS
  const { text, baseUrl } = ttsQueue.shift();
  playEdgeTTS(text, baseUrl);
}

function enqueueTTS(text, baseUrl) {
  if (!overlayConfig.ttsEnabled || !text) return;
  if (ttsQueue.length >= 30) return;  // 队列满时不追加，避免跳过已排队项
  ttsQueue.push({ text, baseUrl });
  if (!ttsPlaying) playNextTTS();
}

function renderSubtitle() {
  const text = [stableSubtitle, pendingSubtitle].filter(Boolean).join("\n");
  showSubtitle(text);
}

function getVideoElement() {
  const videos = document.querySelectorAll("video");
  for (const v of videos) {
    if (v.readyState >= 2 && v.duration > 0) return v;
  }
  return videos[0] || null;
}

async function captureFromVideo() {
  const video = getVideoElement();
  if (!video) throw new Error("页面中未找到视频元素");
  if (typeof video.captureStream !== "function") {
    throw new Error("此视频不支持 captureStream（如 DRM 内容），请尝试使用「共享标签页」");
  }
  return video.captureStream();
}

async function captureFromDisplay() {
  return await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
}

function createResampler() {
  return new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
}

function sendJson(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function closeSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }
}

function getAccumulatedAudio() {
  if (accumulatedChunks.length === 0) return null;
  const total = accumulatedChunks.reduce((a, c) => a + c.length, 0);
  const merged = new Int16Array(total);
  let offset = 0;
  for (const c of accumulatedChunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged.buffer;
}

async function startCaptureStreaming(useDisplayMedia = false) {
  const stream = useDisplayMedia ? await captureFromDisplay() : await captureFromVideo();
  const audioCtx = createResampler();
  await audioCtx.resume();
  const src = audioCtx.createMediaStreamSource(stream);
  const bufferSize = 4096;
  const scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
  const silentSink = audioCtx.createGain();
  silentSink.gain.value = 0;
  const chunks = [];

  sendJson({ type: "config", sampleRate: audioCtx.sampleRate, chunkMs: CHUNK_MS });

  scriptNode.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const buf = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    chunks.push(buf);
  };

  src.connect(scriptNode);
  scriptNode.connect(silentSink);
  silentSink.connect(audioCtx.destination);

  const interval = setInterval(() => {
    if (chunks.length === 0) return;
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Int16Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    chunks.length = 0;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(merged.buffer);
    }
  }, CHUNK_MS);

  return () => {
    clearInterval(interval);
    scriptNode.disconnect();
    silentSink.disconnect();
    src.disconnect();
    audioCtx.close();
    stream.getTracks().forEach((t) => t.stop());
  };
}

async function startCaptureBatch(useDisplayMedia = false) {
  const stream = useDisplayMedia ? await captureFromDisplay() : await captureFromVideo();
  const audioCtx = createResampler();
  await audioCtx.resume();
  const src = audioCtx.createMediaStreamSource(stream);
  const bufferSize = 4096;
  const scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
  const silentSink = audioCtx.createGain();
  silentSink.gain.value = 0;

  accumulatedChunks = [];
  isCapturing = true;

  scriptNode.onaudioprocess = (e) => {
    if (!isCapturing) return;
    const input = e.inputBuffer.getChannelData(0);
    const buf = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    accumulatedChunks.push(buf);
  };

  src.connect(scriptNode);
  scriptNode.connect(silentSink);
  silentSink.connect(audioCtx.destination);

  return () => {
    isCapturing = false;
    scriptNode.disconnect();
    silentSink.disconnect();
    src.disconnect();
    audioCtx.close();
    stream.getTracks().forEach((t) => t.stop());
  };
}

async function startRealtime(wsUrl) {
  closeSocket();
  if (stopCaptureFn) {
    stopCaptureFn();
    stopCaptureFn = null;
  }
  resetSubtitleState();

  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };

    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = async () => {
      try {
        const video = getVideoElement();
        if (video?.paused) {
          video.play().catch(() => {});
          ensureOverlay().textContent = "请先点击播放视频";
          ensureOverlay().classList.remove("hidden");
        }
        if (overlayConfig.ttsEnabled) {
          document.addEventListener("click", () => unlockAudio(), { once: true });
        }
        try {
          stopCaptureFn = await startCaptureStreaming(false);
        } catch (_) {
          stopCaptureFn = await startCaptureStreaming(true);
        }
        if (overlayConfig.showSubtitle) {
          ensureOverlay().classList.remove("hidden");
          pendingSubtitle = "翻译中...";
          renderSubtitle();
        }
        settle(resolve);
      } catch (err) {
        showSubtitle("无法捕获音频: " + (err?.message || err), true);
        closeSocket();
        settle(reject, new Error(err?.message || err));
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data);
        const baseUrl = (overlayConfig.wsUrl || "").replace(/^ws/, "http").replace(/\/ws$/, "");
        if (msg.type === "partial") {
          pendingSubtitle = msg.text || "";
          renderSubtitle();
        } else if (msg.type === "final") {
          stableSubtitle = msg.text || stableSubtitle;
          pendingSubtitle = "";
          renderSubtitle();
          if (msg.text) enqueueTTS(msg.text, baseUrl);
        } else if (msg.type === "subtitle" && msg.text) {
          stableSubtitle = msg.text;
          pendingSubtitle = "";
          renderSubtitle();
          enqueueTTS(msg.text, baseUrl);
        } else if (msg.type === "model_ready") {
          pendingSubtitle = "模型已就绪";
          renderSubtitle();
        } else if (msg.type === "error") {
          showSubtitle("错误: " + msg.message, true);
        }
      } catch (_) {}
    };

    ws.onerror = () => {
      showSubtitle("连接失败，请确认本地服务已启动", true);
      settle(reject, new Error("WebSocket 连接失败"));
    };

    ws.onclose = () => {
      if (stopCaptureFn) {
        stopCaptureFn();
        stopCaptureFn = null;
      }
      if (!settled) settle(reject, new Error("连接已关闭"));
    };
  });
}

async function startBatch(wsUrl) {
  if (stopCaptureFn) {
    stopCaptureFn();
    stopCaptureFn = null;
  }

  await new Promise((resolve, reject) => {
    (async () => {
      try {
        const video = getVideoElement();
        if (video?.paused) {
          video.play().catch(() => {});
          ensureOverlay().textContent = "请先点击播放视频，开始录制后将自动采集音频";
          ensureOverlay().classList.remove("hidden");
        }
        try {
          stopCaptureFn = await startCaptureBatch(false);
        } catch (_) {
          stopCaptureFn = await startCaptureBatch(true);
        }
        if (overlayConfig.showSubtitle) {
          ensureOverlay().classList.remove("hidden");
          ensureOverlay().textContent = "正在录制... 播放完视频后点击「完成提取」";
        }
        resolve();
      } catch (err) {
        showSubtitle("无法捕获音频: " + (err?.message || err), true);
        reject(new Error(err?.message || err));
      }
    })();
  });
}

async function finishBatch(wsUrl) {
  if (stopCaptureFn) {
    stopCaptureFn();
    stopCaptureFn = null;
  }

  const baseUrl = wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
  const audio = getAccumulatedAudio();
  if (!audio || audio.byteLength < 3200) {
    showSubtitle("未采集到足够音频（至少约 0.2 秒），请先播放视频录制", true);
    return { ok: false, err: "音频过短" };
  }

  showSubtitle("正在转写中，请稍候...");

  try {
    const formData = new FormData();
    formData.append("audio", new Blob([audio], { type: "application/octet-stream" }), "audio.pcm");
    const r = await fetch(baseUrl + "/transcribe", { method: "POST", body: formData });
    const data = await r.json();

    if (data.error) {
      showSubtitle("错误: " + data.error, true);
      return { ok: false, err: data.error };
    }
    if (!data.en && !data.zh) {
      showSubtitle("未识别到语音内容", true);
      return { ok: false, err: "未识别到语音" };
    }
    showTranscript(data.en || "", data.zh || "");
    return { ok: true };
  } catch (e) {
    const msg = e?.message || String(e);
    showSubtitle("转写失败: " + msg, true);
    return { ok: false, err: msg };
  }
}

function stop() {
  closeSocket();
  ttsQueue = [];
  ttsPlaying = false;
  if (stopCaptureFn) {
    stopCaptureFn();
    stopCaptureFn = null;
  }
  accumulatedChunks = [];
  isCapturing = false;
  resetSubtitleState();
  hideOverlay();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "start") {
    overlayConfig = {
      fontSize: msg.fontSize || "18",
      position: msg.position || "bottom",
      showSubtitle: msg.showSubtitle !== false,
      ttsEnabled: msg.ttsEnabled === true,
      wsUrl: msg.wsUrl,
    };
    mode = msg.mode || "realtime";
    const startFn = mode === "batch" ? startBatch : startRealtime;
    startFn(msg.wsUrl).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, err: e.message }));
    return true;
  }
  if (msg.action === "finish") {
    if (mode !== "batch") {
      sendResponse({ ok: false, err: "当前为实时模式，请使用批量提取模式" });
      return false;
    }
    finishBatch(msg.wsUrl).then((res) => sendResponse(res || { ok: true }));
    return true;
  }
  if (msg.action === "stop") {
    stop();
    sendResponse({ ok: true });
    return false;
  }
});
