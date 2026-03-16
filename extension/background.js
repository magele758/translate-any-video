/* 由 background 发起 TTS 请求，绕过 content script 的 CORS 限制 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "tts") {
    const url = (msg.baseUrl || "").replace(/\/$/, "") + "/tts?text=" + encodeURIComponent(msg.text || "");
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .then((buf) => sendResponse({ ok: true, audio: buf }))
      .catch((e) => sendResponse({ ok: false, err: String(e) }));
    return true;
  }
});
