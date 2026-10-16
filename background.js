const DEFAULT_STATE = {
  status: "idle",
  tabId: null,
  tabTitle: "",
  domain: "",
  targetLanguage: "fa",
  startedAt: null,
  elapsedSeconds: 0,
  latestOriginal: "",
  latestTranslation: "",
  bufferMs: 0,
  playbackRate: 1,
  cueCount: 0,
  error: ""
};

const DEFAULT_SETTINGS = {
  targetLanguage: "fa",
  originalVolume: 0.2,
  translatedVolume: 1,
  autoDucking: true,
  captionsEnabled: true,
  captionScale: "md",
  voiceName: "auto",
  model: "gemini-3.5-live-translate-preview",
  autoCatchUp: true,
  lowLatencyMode: true,
  smartSync: true,
  rememberKey: false,
  collectLocalStats: true,
  storeDomainLocally: false
};

const IDLE_ICONS = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png"
};

const LIVE_ICONS = {
  16: "icons/icon-live-16.png",
  32: "icons/icon-live-32.png",
  48: "icons/icon-live-48.png",
  128: "icons/icon-live-128.png"
};

let state = { ...DEFAULT_STATE };
let currentCues = [];

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["papaSettings", "navaSettings", "papaSessions", "navaSessions"]);
  const mergedSettings = {
    ...DEFAULT_SETTINGS,
    ...(stored.navaSettings || {}),
    ...(stored.papaSettings || {})
  };
  const updates = { papaSettings: mergedSettings };
  if (!stored.papaSessions && Array.isArray(stored.navaSessions)) {
    updates.papaSessions = stored.navaSessions;
  }
  await chrome.storage.local.set(updates);
  await saveState();
  await updateActionIndicator();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  if (state.status !== "idle") {
    state = { ...DEFAULT_STATE, targetLanguage: state.targetLanguage || "fa" };
    await saveState();
  }
  await updateActionIndicator();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch(async (error) => {
      const friendly = friendlyError(error);
      if (["START_DUBBING", "OFFSCREEN_ERROR"].includes(message?.type)) {
        await setState({ status: "error", error: friendly });
      }
      sendResponse({ ok: false, error: friendly });
    });

  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-dubbing") return;
  await loadState();
  if (["connecting", "live"].includes(state.status)) {
    await stopDubbing();
  } else {
    await startDubbing({});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadState();
  if (state.tabId === tabId && state.status !== "idle") {
    await stopDubbing("تب بسته شد");
  }
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_APP_DATA": {
      await loadState();
      const settings = await getSettings();
      const cues = await getStoredCues();
      return {
        state: { ...state, cueCount: cues.length },
        settings,
        hasKey: await hasApiKey()
      };
    }
    case "GET_SRT_DATA": {
      await loadState();
      const cues = await getStoredCues();
      return {
        cues,
        srt: buildSrtContent(cues),
        title: state.tabTitle || state.domain || "papa-dub-session"
      };
    }
    case "LIST_MODELS":
      return listLiveModels();
    case "SAVE_API_KEY":
      return saveApiKey(message.key, Boolean(message.remember));
    case "CLEAR_API_KEY":
      await Promise.all([
        chrome.storage.session.remove("geminiApiKey"),
        chrome.storage.local.remove("geminiApiKey")
      ]);
      await updateSettings({ rememberKey: false });
      return { hasKey: false };
    case "UPDATE_SETTINGS": {
      const settings = await updateSettings(message.patch || {});
      if (["connecting", "live"].includes(state.status)) {
        await sendToOffscreen({
          type: "UPDATE_AUDIO_SETTINGS",
          settings
        });
        if (state.tabId) {
          if ("captionsEnabled" in (message.patch || {})) {
            if (settings.captionsEnabled) await ensureCaptionOverlay(state.tabId);
            else chrome.tabs.sendMessage(state.tabId, { type: "PAPA_REMOVE_CAPTIONS" }).catch(() => {});
          }
          if ("captionScale" in (message.patch || {})) {
            chrome.tabs.sendMessage(state.tabId, {
              type: "PAPA_CAPTION_STYLE",
              scale: settings.captionScale
            }).catch(() => {});
          }
        }
      }
      return { settings };
    }
    case "START_DUBBING":
      await startDubbing(message.options || {});
      return { state };
    case "STOP_DUBBING":
      await stopDubbing();
      return { state };
    case "OPEN_STATS":
      await chrome.tabs.create({ url: chrome.runtime.getURL("stats.html") });
      return {};
    case "OFFSCREEN_STATUS":
      await setState({
        status: message.status,
        bufferMs: message.bufferMs ?? state.bufferMs,
        error: ""
      });
      return {};
    case "OFFSCREEN_TRANSCRIPT":
      await handleTranscript(message);
      return {};
    case "OFFSCREEN_METRICS":
      await setState({
        bufferMs: message.bufferMs || 0,
        playbackRate: message.playbackRate || 1
      });
      return {};
    case "OFFSCREEN_ERROR":
      await setState({ status: "error", error: friendlyError(message.error) });
      return {};
    case "OFFSCREEN_STOPPED":
      await finishSession(message.durationSeconds);
      return {};
    default:
      return {};
  }
}

async function startDubbing(options) {
  await loadState();
  if (["connecting", "live"].includes(state.status)) return;

  const key = await getApiKey();
  if (!key) throw new Error("ابتدا کلید Gemini API را در تنظیمات وارد کنید.");

  const settings = await updateSettings(options);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    throw new Error("این صفحه قابل ضبط نیست. یک وب‌سایت معمولی دارای صدا را باز کنید.");
  }

  const [, streamId] = await Promise.all([
    ensureOffscreenDocument(),
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id })
  ]);
  const domain = safeDomain(tab.url);

  currentCues = [];
  await chrome.storage.session.set({ papaCues: [] });

  await setState({
    ...DEFAULT_STATE,
    status: "connecting",
    tabId: tab.id,
    tabTitle: tab.title || domain,
    domain,
    targetLanguage: settings.targetLanguage,
    startedAt: Date.now(),
    cueCount: 0
  });

  if (settings.captionsEnabled) await ensureCaptionOverlay(tab.id, settings.captionScale);

  await sendToOffscreen({
    type: "START_CAPTURE",
    streamId,
    apiKey: key,
    targetLanguage: settings.targetLanguage,
    model: /^[a-z0-9][\w.\-]{2,100}$/i.test(settings.model || "") ? settings.model : DEFAULT_SETTINGS.model,
    settings
  });
}

async function stopDubbing(reason = "") {
  await loadState();
  if (state.status === "idle") return;
  await sendToOffscreen({ type: "STOP_CAPTURE", reason }).catch(() => {});
  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, { type: "PAPA_REMOVE_CAPTIONS" }).catch(() => {});
  }
  if (state.status === "error") await finishSession();
}

async function finishSession(durationOverride) {
  await loadState();
  const oldState = { ...state };
  const durationSeconds = Number.isFinite(durationOverride)
    ? Math.max(0, Math.round(durationOverride))
    : oldState.startedAt
      ? Math.max(0, Math.round((Date.now() - oldState.startedAt) / 1000))
      : 0;

  const cues = await getStoredCues();
  const settings = await getSettings();
  if (settings.collectLocalStats && durationSeconds >= 3) {
    await appendSession({
      id: crypto.randomUUID(),
      startedAt: oldState.startedAt || Date.now(),
      durationSeconds,
      targetLanguage: oldState.targetLanguage,
      domain: settings.storeDomainLocally ? oldState.domain : "",
      cueCount: cues.length,
      srt: cues.length ? buildSrtContent(cues.slice(-300)) : ""
    });
  }

  state = {
    ...DEFAULT_STATE,
    targetLanguage: oldState.targetLanguage || "fa",
    cueCount: cues.length
  };
  await saveState();
  await updateActionIndicator();
  broadcastState();
}

async function handleTranscript(message) {
  await loadState();
  const patch = {};
  if (typeof message.original === "string") patch.latestOriginal = message.original;
  if (typeof message.translation === "string") patch.latestTranslation = message.translation;

  // Record subtitle cue when translation updates
  if (typeof message.translation === "string" && message.translation.trim()) {
    const cues = await getStoredCues();
    const nowSec = Number.isFinite(message.elapsedSec)
      ? Math.max(0, Number(message.elapsedSec))
      : state.startedAt
        ? Math.max(0, (Date.now() - state.startedAt) / 1000)
        : 0;

    const last = cues[cues.length - 1];
    const cleanTrans = message.translation.trim();
    const cleanOrig = (message.original || state.latestOriginal || "").trim();

    // Update last cue if it belongs to the same ongoing utterance within 4 seconds
    if (last && (nowSec - last.startSec < 4.2) && (cleanTrans.startsWith(last.translation.slice(0, 10)) || last.translation.startsWith(cleanTrans.slice(0, 10)))) {
      last.translation = cleanTrans;
      if (cleanOrig) last.original = cleanOrig;
      last.endSec = Math.max(last.startSec + 1.5, nowSec + 1.2);
    } else if (!last || last.translation !== cleanTrans) {
      const startSec = last ? Math.max(last.endSec, nowSec - 1.2) : Math.max(0, nowSec - 1.0);
      cues.push({
        startSec: Number(startSec.toFixed(2)),
        endSec: Number((startSec + 2.8).toFixed(2)),
        original: cleanOrig,
        translation: cleanTrans
      });
    }
    currentCues = cues.slice(-1000);
    await chrome.storage.session.set({ papaCues: currentCues });
    patch.cueCount = currentCues.length;
  }

  await setState(patch);

  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, {
      type: "PAPA_CAPTION",
      original: state.latestOriginal,
      translation: state.latestTranslation
    }).catch(() => {});
  }
}

async function getStoredCues() {
  if (currentCues.length) return currentCues;
  const { papaCues = [] } = await chrome.storage.session.get("papaCues");
  currentCues = Array.isArray(papaCues) ? papaCues : [];
  return currentCues;
}

function formatSrtTime(totalSeconds) {
  const sec = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);
  const millis = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(Math.min(999, millis)).padStart(3, "0")}`;
}

function buildSrtContent(cues = []) {
  if (!cues.length) return "";
  return cues.map((cue, index) => {
    const start = formatSrtTime(cue.startSec);
    const end = formatSrtTime(Math.max(cue.startSec + 1.2, cue.endSec || cue.startSec + 2.5));
    const lines = [];
    if (cue.original) lines.push(cue.original);
    if (cue.translation) lines.push(cue.translation);
    return `${index + 1}\n${start} --> ${end}\n${lines.join("\n")}`;
  }).join("\n\n") + "\n";
}

async function saveApiKey(rawKey, remember) {
  const key = String(rawKey || "").trim();
  if (!/^AIza[\w-]{20,}$/.test(key)) {
    throw new Error("ساختار کلید معتبر نیست. کلید Gemini معمولاً با AIza شروع می‌شود.");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
  );
  if (!response.ok) {
    if ([400, 401, 403].includes(response.status)) throw new Error("کلید Gemini معتبر نیست یا دسترسی API ندارد.");
    throw new Error("فعلاً امکان بررسی کلید وجود ندارد. اتصال اینترنت را بررسی کنید.");
  }

  if (remember) {
    await chrome.storage.local.set({ geminiApiKey: key });
    await chrome.storage.session.remove("geminiApiKey");
  } else {
    await chrome.storage.session.set({ geminiApiKey: key });
    await chrome.storage.local.remove("geminiApiKey");
  }
  await updateSettings({ rememberKey: remember });
  return { hasKey: true };
}

async function listLiveModels() {
  const key = await getApiKey();
  if (!key) throw new Error("ابتدا کلید Gemini API را وارد کنید.");
  const models = [];
  let pageToken = "";
  for (let page = 0; page < 5; page += 1) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const response = await fetch(url);
    if (!response.ok) throw new Error("دریافت فهرست مدل‌ها ممکن نشد.");
    const data = await response.json();
    for (const model of data.models || []) {
      if ((model.supportedGenerationMethods || []).includes("bidiGenerateContent")) {
        models.push({ id: String(model.name).replace(/^models\//, ""), displayName: model.displayName || "" });
      }
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return { models };
}

async function getApiKey() {
  const session = await chrome.storage.session.get("geminiApiKey");
  if (session.geminiApiKey) return session.geminiApiKey;
  const local = await chrome.storage.local.get("geminiApiKey");
  return local.geminiApiKey || "";
}

async function hasApiKey() {
  return Boolean(await getApiKey());
}

async function getSettings() {
  const { papaSettings, navaSettings } = await chrome.storage.local.get(["papaSettings", "navaSettings"]);
  return { ...DEFAULT_SETTINGS, ...(navaSettings || {}), ...(papaSettings || {}) };
}

async function updateSettings(patch) {
  const current = await getSettings();
  const allowed = Object.fromEntries(
    Object.entries(patch || {}).filter(([key]) => key in DEFAULT_SETTINGS)
  );
  const next = { ...current, ...allowed };
  await chrome.storage.local.set({ papaSettings: next });
  return next;
}

async function appendSession(session) {
  const { papaSessions, navaSessions } = await chrome.storage.local.get(["papaSessions", "navaSessions"]);
  const list = Array.isArray(papaSessions) ? papaSessions : (Array.isArray(navaSessions) ? navaSessions : []);
  list.push(session);
  await chrome.storage.local.set({ papaSessions: list.slice(-1000) });
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture tab audio, stream it to Gemini Live for PAPA Dub translation, and play dubbed audio."
  });
}

async function ensureCaptionOverlay(tabId, scale = "md") {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["caption-overlay.css"] });
  } catch (_) {
    // The stylesheet may already be present after a previous run.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["caption-overlay.js"] });
  chrome.tabs.sendMessage(tabId, { type: "PAPA_CAPTION_STYLE", scale }).catch(() => {});
}

async function sendToOffscreen(payload) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...payload });
}

async function loadState() {
  const stored = await chrome.storage.session.get(["papaState", "navaState"]);
  state = { ...DEFAULT_STATE, ...(stored.navaState || {}), ...(stored.papaState || state) };
}

async function saveState() {
  await chrome.storage.session.set({ papaState: state });
}

async function setState(patch) {
  const prevStatus = state.status;
  state = { ...state, ...patch };
  await saveState();
  if (patch.status && patch.status !== prevStatus) {
    await updateActionIndicator();
  }
  broadcastState();
}

async function updateActionIndicator() {
  if (!chrome.action) return;
  try {
    if (state.status === "live") {
      await chrome.action.setIcon({ path: LIVE_ICONS });
      await chrome.action.setBadgeText({ text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ color: "#15B88E" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: "#042019" });
      }
      await chrome.action.setTitle({
        title: `PAPA Dub · فعال (${(state.targetLanguage || "fa").toUpperCase()})${state.tabTitle ? " — " + state.tabTitle : ""}`
      });
    } else if (state.status === "connecting") {
      await chrome.action.setIcon({ path: LIVE_ICONS });
      await chrome.action.setBadgeText({ text: "..." });
      await chrome.action.setBadgeBackgroundColor({ color: "#F7C66C" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: "#1F1600" });
      }
      await chrome.action.setTitle({ title: "PAPA Dub · در حال اتصال به Gemini…" });
    } else if (state.status === "error") {
      await chrome.action.setIcon({ path: IDLE_ICONS });
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#FF6A63" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
      }
      await chrome.action.setTitle({ title: `PAPA Dub · خطا: ${state.error || "متوقف شد"}` });
    } else {
      await chrome.action.setIcon({ path: IDLE_ICONS });
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "PAPA Dub — دوبله زنده فوق‌سریع" });
    }
  } catch (_) {
    // Ignore indicator errors if browser window is closing
  }
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: "STATE_UPDATED", state }).catch(() => {});
}

function safeDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function friendlyError(error) {
  const text = String(error?.message || error || "خطای ناشناخته");
  if (/invalid json payload|unknown name|cannot find field/i.test(text)) {
    return "ساختار درخواست با نسخه فعلی Gemini سازگار نیست. اکستنشن PAPA Dub را به آخرین نسخه به‌روزرسانی کنید.";
  }
  if (/quota|resource_exhausted|429/i.test(text)) return "سهمیه Gemini تمام شده است. کمی بعد دوباره تلاش کنید.";
  if (/network|failed to fetch|offline/i.test(text)) return "اتصال اینترنت برقرار نیست یا Gemini در دسترس نیست.";
  if (/not allowed|permission|capture/i.test(text)) return "Chrome اجازه ضبط صدای این تب را نداد.";
  return text;
}
