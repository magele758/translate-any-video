const DEFAULT_WS = "ws://localhost:8765/ws";

chrome.storage.local.get(["serverUrl", "fontSize", "position", "showSubtitle", "ttsEnabled", "mode"], (r) => {
  document.getElementById("serverUrl").value = r.serverUrl || DEFAULT_WS;
  document.getElementById("fontSize").value = r.fontSize || "18";
  document.getElementById("position").value = r.position || "bottom";
  document.getElementById("showSubtitle").checked = r.showSubtitle !== false;
  document.getElementById("ttsEnabled").checked = r.ttsEnabled !== false;
  const mode = r.mode || "realtime";
  document.getElementById("modeRealtime").classList.toggle("active", mode === "realtime");
  document.getElementById("modeBatch").classList.toggle("active", mode === "batch");
  document.getElementById("realtimeBtns").style.display = mode === "realtime" ? "flex" : "none";
  document.getElementById("batchBtns").style.display = mode === "batch" ? "flex" : "none";
});

document.getElementById("modeRealtime").onclick = () => {
  document.getElementById("modeRealtime").classList.add("active");
  document.getElementById("modeBatch").classList.remove("active");
  document.getElementById("realtimeBtns").style.display = "flex";
  document.getElementById("batchBtns").style.display = "none";
  chrome.storage.local.set({ mode: "realtime" });
  setStatus("实时字幕：边播边译", "info");
};

document.getElementById("modeBatch").onclick = () => {
  document.getElementById("modeBatch").classList.add("active");
  document.getElementById("modeRealtime").classList.remove("active");
  document.getElementById("batchBtns").style.display = "flex";
  document.getElementById("realtimeBtns").style.display = "none";
  chrome.storage.local.set({ mode: "batch" });
  setStatus("批量提取：录制后一次性解析全文", "info");
};

async function getTabAndUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return [null, null];
  const url = document.getElementById("serverUrl").value.trim() || DEFAULT_WS;
  return [tab, url];
}

async function checkHealth() {
  const url = document.getElementById("serverUrl").value.trim() || DEFAULT_WS;
  const httpUrl = url.replace(/^ws/, "http").replace(/\/ws$/, "");
  const r = await fetch(httpUrl + "/health");
  return r.json();
}

async function doStart(mode) {
  const [tab, url] = await getTabAndUrl();
  if (!tab) {
    setStatus("无法获取当前标签页", "error");
    return;
  }
  const fontSize = document.getElementById("fontSize").value;
  const position = document.getElementById("position").value;
  const showSubtitle = document.getElementById("showSubtitle").checked;
  const ttsEnabled = document.getElementById("ttsEnabled").checked;
  await chrome.storage.local.set({ serverUrl: url, fontSize, position, showSubtitle, ttsEnabled });

  try {
    const h = await checkHealth();
    if (h.status === "warming") {
      setStatus((h.message || "模型加载中") + "，请稍候...", "info");
    } else if (h.status === "error") {
      setStatus("服务异常: " + (h.message || ""), "error");
      return;
    }
  } catch (e) {
    setStatus("无法连接服务。请先运行: cd server && conda activate asr-translate && python main.py", "error");
    return;
  }

  const payload = { action: "start", wsUrl: url, fontSize, position, showSubtitle, ttsEnabled, mode };
  try {
    await chrome.tabs.sendMessage(tab.id, payload);
    setStatus(mode === "batch" ? "已开始录制，播放视频后点「完成提取」" : "已启动，正在翻译...", "ok");
  } catch (e) {
    if (e.message?.includes("Receiving end does not exist")) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/content.js"] });
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/overlay.css"] });
        await chrome.tabs.sendMessage(tab.id, payload);
        setStatus(mode === "batch" ? "已开始录制" : "已启动", "ok");
      } catch (e2) {
        setStatus("无法注入脚本，请刷新页面后重试", "error");
      }
    } else {
      setStatus("启动失败: " + (e.message || "请刷新页面后重试"), "error");
    }
  }
}

document.getElementById("start").onclick = () => doStart("realtime");
document.getElementById("startBatch").onclick = () => doStart("batch");

document.getElementById("finish").onclick = async () => {
  const [tab, url] = await getTabAndUrl();
  if (!tab) {
    setStatus("无法获取当前标签页", "error");
    return;
  }
  setStatus("正在提取字幕...", "info");
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: "finish", wsUrl: url });
    setStatus(res?.ok ? "提取完成，字幕已显示在页面" : "提取失败: " + (res?.err || ""), res?.ok ? "ok" : "error");
  } catch (e) {
    setStatus("提取失败: " + (e?.message || "请先点击「开始录制」"), "error");
  }
};

async function doStop() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "stop" });
    } catch (_) {}
  }
  setStatus("已停止", "ok");
}

document.getElementById("stop").onclick = doStop;
document.getElementById("stopBatch").onclick = doStop;

document.getElementById("testTts").onclick = async () => {
  const url = document.getElementById("serverUrl").value.trim() || DEFAULT_WS;
  const baseUrl = url.replace(/^ws/, "http").replace(/\/ws$/, "");
  const ttsUrl = baseUrl + "/tts?text=" + encodeURIComponent("你好，这是语音测试");
  setStatus("测试中...", "info");
  try {
    const r = await fetch(ttsUrl);
    if (!r.ok) throw new Error(r.status);
    const blob = await r.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    audio.onended = () => setStatus("TTS 测试成功", "ok");
    audio.onerror = () => setStatus("TTS 播放失败", "error");
    await audio.play();
  } catch (e) {
    setStatus("TTS 测试失败: " + (e?.message || e), "error");
  }
};

function setStatus(msg, type) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status " + (type || "info");
}
