import { getConfig } from "./lib/storage.js";

const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");
const pauseBtn = document.getElementById("pause");
const resumeBtn = document.getElementById("resume");
const stopBtn = document.getElementById("stop");
const popoutBtn = document.getElementById("popout");
const shortcutsBtn = document.getElementById("shortcuts");
const settingsBtn = document.getElementById("settings");
const metaEl = document.getElementById("meta");

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + kind;
}

async function refresh() {
  const cfg = await getConfig();
  metaEl.textContent = `${cfg.provider}: ${cfg.model || "(no model set)"}  |  STT: ${cfg.sttProvider}`;

  const st = await chrome.runtime.sendMessage({ type: "get-session-state" });
  const active = !!st?.active;
  const paused = !!st?.paused;
  if (active && paused) {
    setStatus("Paused", "paused");
  } else if (active) {
    setStatus("Listening", "active");
  } else {
    setStatus("Idle");
  }
  startBtn.disabled = active;
  stopBtn.disabled = !active;
  pauseBtn.disabled = !active || paused;
  resumeBtn.disabled = !active || !paused;
  pauseBtn.hidden = paused;
  resumeBtn.hidden = !paused;

  if (!cfg.apiKeys?.length) {
    setStatus("No LLM API key configured", "error");
    startBtn.disabled = true;
  }
  if (cfg.sttProvider === "assemblyai" && !cfg.sttApiKey?.trim()) {
    setStatus("No AssemblyAI key configured", "error");
    startBtn.disabled = true;
  }
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  setStatus("Starting...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab.");

    // Make sure any previous session is fully torn down before we ask Chrome
    // for a fresh tabCapture streamId. Without this, getMediaStreamId can
    // return a stale id whose subsequent getUserMedia call rejects with
    // "Could not start audio source" - which is the classic "second Start
    // does nothing" symptom.
    await chrome.runtime.sendMessage({ type: "stop-session" }).catch(() => { });

    // getMediaStreamId must be called from a user-gesture context (popup is one).
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!id) reject(new Error("No streamId returned by chrome.tabCapture"));
        else resolve(id);
      });
    });

    const res = await chrome.runtime.sendMessage({
      type: "start-session",
      tabId: tab.id,
      windowId: tab.windowId,
      streamId,
    });
    if (!res?.ok) throw new Error(res?.error || "Failed to start (no error returned)");
    setStatus("Listening", "active");
    stopBtn.disabled = false;
    setTimeout(() => window.close(), 200);
  } catch (e) {
    console.error("[IC popup] start failed:", e);
    setStatus(`Start failed: ${e.message || e}`, "error");
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  setStatus("Stopping...");
  try {
    await chrome.runtime.sendMessage({ type: "stop-session" });
    setStatus("Idle");
  } catch (e) {
    console.error("[IC popup] stop failed:", e);
    setStatus(`Stop failed: ${e.message || e}`, "error");
  }
  startBtn.disabled = false;
});

pauseBtn.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "pause-session" });
    refresh();
  } catch (e) {
    setStatus(`Pause failed: ${e.message || e}`, "error");
  }
});

resumeBtn.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "resume-session" });
    refresh();
  } catch (e) {
    setStatus(`Resume failed: ${e.message || e}`, "error");
  }
});

// Third trigger path for the floating panel: a button right here in the
// popup. Reuses the same "panel-toggle-popout" message the chrome.commands
// hotkey and the right-click context menu both send. The popup-button click
// is itself a user activation, and chrome.tabs.sendMessage propagates it to
// the active tab's content script, so requestWindow() succeeds without a
// "user gesture required" rejection. Note: we close the popup ~120 ms after
// dispatching so Chrome doesn't tear down the popup process before the
// content script has a chance to handle the message.
popoutBtn.addEventListener("click", async () => {
  popoutBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab");
    await chrome.tabs.sendMessage(tab.id, { type: "panel-toggle-popout" });
    setTimeout(() => window.close(), 120);
  } catch (e) {
    console.error("[IC popup] popout failed:", e);
    setStatus(`Pop out failed: ${e.message || e}`, "error");
    popoutBtn.disabled = false;
  }
});

// Open Chrome's built-in extension shortcut manager. We use chrome.tabs
// (not window.open) because chrome:// URLs are blocked from regular
// scripts; tabs.create from the popup IS allowed for chrome:// pages
// in MV3.
shortcutsBtn?.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  setTimeout(() => window.close(), 100);
});

settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "session-state") refresh();
  if (m?.type === "error") setStatus(m.error, "error");
});

refresh();
