// ==UserScript==
// @name         Bilibili Watch Together MVP
// @namespace    https://github.com/local/bilibili-watch-together
// @version      2.1.2
// @description  Sync Bilibili playback across browsers through an HTTPS polling room service.
// @author       Codex
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "vt-watch-together-panel";
  const STORAGE_KEY = "vt-watch-together-api-base";
  const SESSION_KEY = "vt-watch-together-session";
  const DEFAULT_API_BASE = localStorage.getItem(STORAGE_KEY) || "http://localhost:8787";
  const SEEK_TOLERANCE = 0.8;
  const REMOTE_GUARD_MS = 1200;
  const SEEK_BROADCAST_DEBOUNCE_MS = 350;
  const POLL_INTERVAL_MS = 1200;
  const AUTO_REJOIN_DELAY_MS = 1200;

  const state = {
    clientId: `client_${Math.random().toString(36).slice(2, 10)}`,
    roomId: "",
    apiBase: DEFAULT_API_BASE,
    connectionState: "idle",
    isMaster: false,
    currentVideo: null,
    currentVideoKey: { url: location.href },
    isApplyingRemoteEvent: false,
    lastRemoteAppliedAt: 0,
    seekTimer: null,
    pollTimer: null,
    lastEventId: 0,
    lastLog: "脚本已加载，等待初始化",
    autoplayHint: "",
    lastKnownUrl: normalizeContentUrl(location.href),
    initialized: false,
    panelAttached: false,
    isPolling: false,
    autoJoinAttempted: false
  };

  let ui = null;

  console.log("[watch-together] userscript loaded", location.href);
  bootstrap();

  function bootstrap() {
    restoreSession();
    init();
    document.addEventListener("DOMContentLoaded", init, { once: true });
    window.addEventListener("load", init, { once: true });
    window.setTimeout(init, 500);
    window.setTimeout(init, 1500);
    window.setTimeout(init, 3000);
  }

  function init() {
    if (!ui) {
      ui = createPanel();
    }

    attachPanel();

    if (!state.initialized) {
      state.initialized = true;
      refreshVideo(true);
      bindUrlWatcher();
      bindVideoListeners();
      render();
      log("脚本初始化完成");
      maybeAutoJoin();
    } else {
      refreshVideo(false);
      bindVideoListeners();
      render();
    }
  }

  function createPanel() {
    const root = document.createElement("div");
    root.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "width:340px",
      "padding:12px",
      "border-radius:12px",
      "background:rgba(20,20,20,0.88)",
      "color:#fff",
      "font:12px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
      "backdrop-filter:blur(12px)"
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "一起看 MVP";
    title.style.cssText = "font-size:14px;font-weight:700;margin-bottom:8px;";

    const apiInput = document.createElement("input");
    apiInput.placeholder = "服务地址，如 https://example.com";
    apiInput.value = state.apiBase;
    apiInput.style.cssText = inputStyle();
    apiInput.addEventListener("change", () => {
      state.apiBase = normalizeApiBase(apiInput.value.trim());
      localStorage.setItem(STORAGE_KEY, state.apiBase);
      persistSession();
      render();
      log(`服务地址已更新为 ${state.apiBase}`);
    });

    const roomInput = document.createElement("input");
    roomInput.placeholder = "房间号";
    roomInput.style.cssText = `${inputStyle()};margin-top:8px;`;
    roomInput.addEventListener("input", () => {
      state.roomId = roomInput.value.trim();
      persistSession();
      render();
    });

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;";

    const connectButton = createButton("加入房间", () => void joinRoom());
    const leaveButton = createButton("离开房间", () => void leaveRoom());
    const masterButton = createButton("申请主控", () => void requestMaster());
    const refreshButton = createButton("重新检测播放器", () => {
      refreshVideo(true);
      bindVideoListeners();
      log(state.currentVideo ? "已重新检测播放器" : "未检测到可播放视频");
    });

    actions.append(connectButton, leaveButton, masterButton, refreshButton);

    const status = document.createElement("div");
    const master = document.createElement("div");
    const videoKey = document.createElement("div");
    const autoplay = document.createElement("div");
    const logBox = document.createElement("div");

    status.style.marginTop = "8px";
    master.style.marginTop = "4px";
    videoKey.style.marginTop = "4px";
    autoplay.style.marginTop = "4px";
    autoplay.style.color = "#ffd166";
    logBox.style.cssText =
      "margin-top:8px;padding:8px;border-radius:8px;background:rgba(255,255,255,0.08);word-break:break-word;max-height:120px;overflow:auto;";

    root.append(title, apiInput, roomInput, actions, status, master, videoKey, autoplay, logBox);

    return {
      root, apiInput, roomInput, connectButton, leaveButton, masterButton, refreshButton,
      status, master, videoKey, autoplay, logBox
    };
  }

  function inputStyle() {
    return "width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#fff;";
  }

  function createButton(label, onClick) {
    const button = document.createElement("button");
    button.textContent = label;
    button.style.cssText = "padding:6px 10px;border:none;border-radius:8px;background:#00a1d6;color:#fff;cursor:pointer;";
    button.addEventListener("click", onClick);
    return button;
  }

  function attachPanel() {
    if (!ui) return;
    if (document.getElementById(PANEL_ID)) { state.panelAttached = true; return; }
    ui.root.id = PANEL_ID;
    (document.body || document.documentElement).appendChild(ui.root);
    state.panelAttached = true;
  }

  function render() {
    if (!ui) return;
    ui.apiInput.value = state.apiBase;
    ui.roomInput.value = state.roomId;
    ui.status.textContent = `连接状态：${formatConnectionState(state.connectionState)}`;
    ui.master.textContent = `当前角色：${state.isMaster ? "主控" : "跟随者"}`;
    ui.videoKey.textContent = `videoKey：${JSON.stringify(state.currentVideoKey)}`;
    ui.autoplay.textContent = state.autoplayHint;
    ui.logBox.textContent = `最近日志：${state.lastLog}`;
    ui.connectButton.disabled = !state.roomId || state.connectionState === "connecting" || state.connectionState === "connected";
    ui.leaveButton.disabled = state.connectionState !== "connected";
    ui.masterButton.disabled = state.connectionState !== "connected";
  }

  function normalizeContentUrl(inputUrl) {
    const parsed = new URL(inputUrl, location.origin);
    const normalized = new URL(`${parsed.origin}${parsed.pathname}`);
    if (parsed.pathname.startsWith("/video/")) {
      const p = parsed.searchParams.get("p");
      if (p) normalized.searchParams.set("p", p);
    }
    return normalized.toString();
  }

  function createVideoKey() {
    const rawUrl = location.href;
    const url = normalizeContentUrl(rawUrl);
    const parsedUrl = new URL(rawUrl);
    const bvidMatch = rawUrl.match(/\/video\/(BV[\w]+)/i);
    const epMatch = rawUrl.match(/\/bangumi\/play\/(ep\d+)/i);
    const seasonMatch = rawUrl.match(/\/bangumi\/play\/(ss\d+)/i);
    const pFromQuery = parsedUrl.searchParams.get("p");
    const p = pFromQuery ? Number(pFromQuery) : undefined;
    return {
      bvid: bvidMatch ? bvidMatch[1] : undefined,
      epId: epMatch ? epMatch[1] : undefined,
      seasonId: seasonMatch ? seasonMatch[1] : undefined,
      p: Number.isFinite(p) ? p : undefined,
      url
    };
  }

  function createMessage(type, payload) {
    return { type, roomId: state.roomId, senderId: state.clientId, timestamp: Date.now(), videoKey: createVideoKey(), payload };
  }

  function log(message) {
    state.lastLog = `[${new Date().toLocaleTimeString()}] ${message}`;
    console.log("[watch-together]", message);
    render();
  }

  function refreshVideo(forceLog) {
    state.currentVideo = findBestVideo();
    state.currentVideoKey = createVideoKey();
    if (forceLog) log(state.currentVideo ? "已检测到可播放视频" : "未检测到可播放视频");
    else render();
  }

  function findBestVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;
    const ranked = videos.map((video) => {
      const rect = video.getBoundingClientRect();
      return { video, visible: rect.width > 0 && rect.height > 0, area: rect.width * rect.height };
    }).sort((a, b) => Number(b.visible) - Number(a.visible) || b.area - a.area);
    return ranked[0] ? ranked[0].video : null;
  }

  function bindVideoListeners() {
    const video = state.currentVideo;
    if (!video || video.dataset.watchTogetherBound === "1") return;
    video.dataset.watchTogetherBound = "1";
    video.addEventListener("play", () => { if (shouldBroadcastLocalEvent()) void postEvent("play", { currentTime: video.currentTime, paused: false }); });
    video.addEventListener("pause", () => { if (shouldBroadcastLocalEvent()) void postEvent("pause", { currentTime: video.currentTime, paused: true }); });
    video.addEventListener("seeking", () => {
      if (!shouldBroadcastLocalEvent()) return;
      if (state.seekTimer) clearTimeout(state.seekTimer);
      state.seekTimer = window.setTimeout(() => { void postEvent("seek", { currentTime: video.currentTime, paused: video.paused }); }, SEEK_BROADCAST_DEBOUNCE_MS);
    });
    video.addEventListener("seeked", () => { if (shouldBroadcastLocalEvent()) void postEvent("seek", { currentTime: video.currentTime, paused: video.paused }); });
    video.addEventListener("loadedmetadata", () => { state.currentVideoKey = createVideoKey(); render(); });
  }

  function shouldBroadcastLocalEvent() {
    if (state.isApplyingRemoteEvent) return false;
    if (!state.isMaster) return false;
    if (Date.now() - state.lastRemoteAppliedAt < REMOTE_GUARD_MS) return false;
    return state.connectionState === "connected";
  }

  async function joinRoom(options) {
    const skipLog = !!(options && options.skipLog);
    const takeoverMaster = !(options && options.autoRestore);
    if (!state.roomId) { log("请先输入房间号"); return; }
    if (state.connectionState === "connecting" || state.connectionState === "connected") return;
    state.connectionState = "connecting";
    state.autoplayHint = "";
    render();
    if (!skipLog) log(`正在连接 ${state.apiBase}`);
    try {
      const response = await apiFetch("/rooms/join", {
        method: "POST",
        body: JSON.stringify({ roomId: state.roomId, clientId: state.clientId, videoKey: createVideoKey(), sinceEventId: state.lastEventId, takeoverMaster })
      });
      state.clientId = response.clientId;
      state.lastEventId = getMaxEventId(response.events, state.lastEventId);
      state.isMaster = response.masterId === state.clientId;
      state.connectionState = "connected";
      persistSession();
      startPolling();
      render();
      log(`已加入房间 ${state.roomId}，当前主控：${response.masterId || "无"}`);
      for (const event of response.events) handleIncomingEvent(event);
    } catch (error) {
      state.connectionState = "disconnected";
      render();
      log(`加入房间失败：${formatError(error)}`);
    }
  }

  async function leaveRoom() {
    stopPolling();
    if (state.connectionState === "connected") {
      try {
        await apiFetch("/rooms/leave", { method: "POST", body: JSON.stringify({ roomId: state.roomId, clientId: state.clientId, videoKey: createVideoKey() }) });
      } catch (error) {
        log(`离开房间请求失败：${formatError(error)}`);
      }
    }
    clearSession();
    state.connectionState = "disconnected";
    state.isMaster = false;
    state.lastEventId = 0;
    render();
    log("已离开房间");
  }

  async function requestMaster() {
    if (state.connectionState !== "connected") return;
    await postEvent("state", { requestedBy: "requestMaster" });
    log("已申请成为主控");
  }

  async function postEvent(type, payload) {
    if (state.connectionState !== "connected") return;
    const message = createMessage(type, payload);
    try {
      const response = await apiFetch("/rooms/events", { method: "POST", body: JSON.stringify(message) });
      if (typeof response.masterId !== "undefined") { state.isMaster = response.masterId === state.clientId; render(); }
      persistSession();
    } catch (error) {
      log(`事件发送失败：${formatError(error)}`);
      if (String(error).includes("Failed to fetch")) { state.connectionState = "disconnected"; render(); }
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = window.setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
    void pollOnce();
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  async function pollOnce() {
    if (state.isPolling || state.connectionState !== "connected") return;
    state.isPolling = true;
    try {
      const query = new URLSearchParams({ roomId: state.roomId, clientId: state.clientId, since: String(state.lastEventId) });
      const response = await apiFetch(`/rooms/poll?${query.toString()}`, { method: "GET" });
      state.isMaster = response.masterId === state.clientId;
      state.lastEventId = getMaxEventId(response.events, state.lastEventId);
      persistSession();
      render();
      for (const event of response.events) handleIncomingEvent(event);
    } catch (error) {
      state.connectionState = "disconnected";
      state.isMaster = false;
      stopPolling();
      render();
      log(`轮询失败：${formatError(error)}`);
    } finally {
      state.isPolling = false;
    }
  }

  function handleIncomingEvent(event) {
    switch (event.type) {
      case "join": log(`成员加入：${event.senderId}`); break;
      case "leave": log(`成员离开：${event.senderId}`); break;
      case "masterChanged":
        state.isMaster = event.payload && event.payload.masterId === state.clientId;
        persistSession();
        log(`主控已切换：${(event.payload && event.payload.masterId) || "无"}`);
        render();
        break;
      case "play":
      case "pause":
      case "seek":
      case "changePart":
        if (event.senderId !== state.clientId) void applyRemoteMessage(event);
        break;
      default: break;
    }
  }

  async function applyRemoteMessage(message) {
    if (message.type === "changePart") {
      state.lastRemoteAppliedAt = Date.now();
      persistSession();
      await applyChangePart(message);
      return;
    }
    refreshVideo(false);
    const video = state.currentVideo;
    if (!video) { log("未检测到播放器，无法执行远端同步"); return; }
    state.isApplyingRemoteEvent = true;
    state.lastRemoteAppliedAt = Date.now();
    try {
      const targetTime = message.payload && message.payload.currentTime;
      if (typeof targetTime === "number" && Math.abs(video.currentTime - targetTime) > SEEK_TOLERANCE) video.currentTime = targetTime;
      if (message.type === "play") { await safePlay(video); log(`已同步播放 @ ${formatTime(video.currentTime)}`); return; }
      if (message.type === "pause") { video.pause(); log(`已同步暂停 @ ${formatTime(video.currentTime)}`); return; }
      if (message.type === "seek") {
        if (message.payload && message.payload.paused === false) await safePlay(video); else video.pause();
        log(`已同步进度到 ${formatTime(video.currentTime)}`);
      }
    } finally {
      window.setTimeout(() => { state.isApplyingRemoteEvent = false; }, 0);
    }
  }

  async function applyChangePart(message) {
    const targetUrl = normalizeContentUrl((message.payload && message.payload.targetUrl) || (message.videoKey && message.videoKey.url) || "");
    if (!targetUrl) return;
    const currentUrl = normalizeContentUrl(location.href);
    if (currentUrl !== targetUrl) { log(`正在同步切换到 ${targetUrl}`); location.href = targetUrl; return; }
    log("远端目标 URL 与当前一致，跳过跳转");
  }

  async function safePlay(video) {
    try {
      await video.play();
      state.autoplayHint = "";
    } catch (error) {
      console.warn("[watch-together] autoplay blocked", error);
      state.autoplayHint = "浏览器阻止了自动播放，请手动点击一次播放以授予权限。";
      log("自动播放被浏览器拦截");
    } finally {
      render();
    }
  }

  function bindUrlWatcher() {
    const observer = new MutationObserver(() => {
      const normalizedUrl = normalizeContentUrl(location.href);
      if (normalizedUrl === state.lastKnownUrl) return;
      const previousUrl = state.lastKnownUrl;
      state.lastKnownUrl = normalizedUrl;
      refreshVideo(false);
      bindVideoListeners();
      attachPanel();
      if (state.connectionState === "connected" && state.isMaster) {
        persistSession();
        void postEvent("changePart", { targetUrl: normalizedUrl });
        log(`URL 已变化，已广播 changePart：${previousUrl} -> ${normalizedUrl}`);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", () => {
      const normalizedUrl = normalizeContentUrl(location.href);
      if (normalizedUrl !== state.lastKnownUrl) {
        state.lastKnownUrl = normalizedUrl;
        refreshVideo(false);
        bindVideoListeners();
        attachPanel();
      }
    });
  }

  function restoreSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        state.roomId = typeof saved.roomId === "string" ? saved.roomId : state.roomId;
        state.apiBase = typeof saved.apiBase === "string" ? saved.apiBase : state.apiBase;
        state.clientId = typeof saved.clientId === "string" ? saved.clientId : state.clientId;
        state.lastEventId = typeof saved.lastEventId === "number" ? saved.lastEventId : 0;
      }
    } catch (error) {
      console.warn("[watch-together] failed to restore session", error);
    }
  }

  function persistSession() {
    try {
      if (!state.roomId) { sessionStorage.removeItem(SESSION_KEY); return; }
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ roomId: state.roomId, apiBase: state.apiBase, clientId: state.clientId, lastEventId: state.lastEventId, savedAt: Date.now() }));
    } catch (error) {
      console.warn("[watch-together] failed to persist session", error);
    }
  }

  function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

  function maybeAutoJoin() {
    if (state.autoJoinAttempted || !state.roomId || !state.apiBase || state.connectionState === "connected") return;
    state.autoJoinAttempted = true;
    window.setTimeout(() => {
      if (state.connectionState === "idle" || state.connectionState === "disconnected") {
        log(`检测到上次房间 ${state.roomId}，尝试自动恢复连接`);
        void joinRoom({ skipLog: true, autoRestore: true });
      }
    }, AUTO_REJOIN_DELAY_MS);
  }

  async function apiFetch(path, options) {
    const response = await fetch(`${normalizeApiBase(state.apiBase)}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options && options.headers ? options.headers : {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function normalizeApiBase(value) { return value.replace(/\/+$/, ""); }

  function getMaxEventId(events, fallback) {
    let current = fallback;
    for (const event of events || []) if (typeof event.id === "number" && event.id > current) current = event.id;
    return current;
  }

  function formatError(error) { return error instanceof Error ? error.message : String(error); }

  function formatTime(seconds) {
    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function formatConnectionState(connectionState) {
    switch (connectionState) {
      case "idle": return "未连接";
      case "connecting": return "连接中";
      case "connected": return "已连接";
      case "disconnected": return "已断开";
      case "error": return "错误";
      default: return connectionState;
    }
  }
})();
