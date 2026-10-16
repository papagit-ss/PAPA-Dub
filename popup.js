const fa = new Intl.NumberFormat("fa-IR");

const KNOWN_MODELS = [
  { id: "gemini-3.5-live-translate-preview", label: "Gemini 3.5 Live Translate — پیشنهادی (کم‌تاخیر)" },
  { id: "gemini-3.8-live", label: "Gemini 3.8 Live — مفسر هوشمند" }
];

const elements = {
  statusStrip: document.querySelector("#statusStrip"),
  statusText: document.querySelector("#statusText"),
  timer: document.querySelector("#timer"),
  targetLanguage: document.querySelector("#targetLanguage"),
  voiceSelect: document.querySelector("#voiceSelect"),
  toggleDubbing: document.querySelector("#toggleDubbing"),
  buttonIcon: document.querySelector("#buttonIcon"),
  buttonLabel: document.querySelector("#buttonLabel"),
  tabHint: document.querySelector("#tabHint"),
  errorCard: document.querySelector("#errorCard"),
  errorText: document.querySelector("#errorText"),
  dismissError: document.querySelector("#dismissError"),
  originalVolume: document.querySelector("#originalVolume"),
  translatedVolume: document.querySelector("#translatedVolume"),
  originalValue: document.querySelector("#originalValue"),
  translatedValue: document.querySelector("#translatedValue"),
  autoDucking: document.querySelector("#autoDucking"),
  captionsEnabled: document.querySelector("#captionsEnabled"),
  lowLatencyMode: document.querySelector("#lowLatencyMode"),
  autoCatchUp: document.querySelector("#autoCatchUp"),
  modelSelect: document.querySelector("#modelSelect"),
  modelHint: document.querySelector("#modelHint"),
  bufferChip: document.querySelector("#bufferChip"),
  transcriptCard: document.querySelector("#transcriptCard"),
  originalLine: document.querySelector("#originalLine"),
  translationLine: document.querySelector("#translationLine"),
  downloadSrt: document.querySelector("#downloadSrt"),
  exportLiveSrt: document.querySelector("#exportLiveSrt"),
  settingsTrigger: document.querySelector("#settingsTrigger"),
  settingsBody: document.querySelector("#settingsBody"),
  keyStatus: document.querySelector("#keyStatus"),
  apiKey: document.querySelector("#apiKey"),
  rememberKey: document.querySelector("#rememberKey"),
  toggleKeyVisibility: document.querySelector("#toggleKeyVisibility"),
  saveKey: document.querySelector("#saveKey"),
  clearKey: document.querySelector("#clearKey"),
  saveMessage: document.querySelector("#saveMessage"),
  openStats: document.querySelector("#openStats")
};

let appState = null;
let settings = null;
let hasKey = false;
let timerId = null;
let updateTimer = null;
let pendingSettingsPatch = {};

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  bindEvents();
  const response = await send({ type: "GET_APP_DATA" });
  if (!response.ok) return showError(response.error);
  appState = response.state;
  settings = response.settings;
  hasKey = response.hasKey;
  applySettings();
  render();
  if (hasKey) loadModels();
}

function bindEvents() {
  elements.toggleDubbing.addEventListener("click", toggleDubbing);
  elements.dismissError.addEventListener("click", () => {
    elements.errorCard.hidden = true;
  });
  elements.openStats.addEventListener("click", () => send({ type: "OPEN_STATS" }));
  elements.downloadSrt.addEventListener("click", downloadSessionSrt);
  elements.exportLiveSrt.addEventListener("click", downloadSessionSrt);

  elements.settingsTrigger.addEventListener("click", () => {
    const open = elements.settingsTrigger.getAttribute("aria-expanded") === "true";
    setSettingsOpen(!open);
  });

  elements.toggleKeyVisibility.addEventListener("click", () => {
    const visible = elements.apiKey.type === "text";
    elements.apiKey.type = visible ? "password" : "text";
    elements.toggleKeyVisibility.textContent = visible ? "نمایش" : "پنهان";
  });

  elements.saveKey.addEventListener("click", saveKey);
  elements.clearKey.addEventListener("click", clearKey);
  elements.targetLanguage.addEventListener("change", () => queueSettings({
    targetLanguage: elements.targetLanguage.value
  }));
  elements.voiceSelect.addEventListener("change", () => queueSettings({
    voiceName: elements.voiceSelect.value
  }));
  elements.modelSelect.addEventListener("change", () => {
    queueSettings({ model: elements.modelSelect.value });
    updateModelHint();
  });
  elements.autoDucking.addEventListener("change", () => queueSettings({
    autoDucking: elements.autoDucking.checked
  }));
  elements.lowLatencyMode.addEventListener("change", () => queueSettings({
    lowLatencyMode: elements.lowLatencyMode.checked
  }));
  elements.autoCatchUp.addEventListener("change", () => queueSettings({
    autoCatchUp: elements.autoCatchUp.checked,
    smartSync: elements.autoCatchUp.checked
  }));
  elements.captionsEnabled.addEventListener("change", () => queueSettings({
    captionsEnabled: elements.captionsEnabled.checked
  }));
  elements.originalVolume.addEventListener("input", () => {
    updateRangeLabels();
    queueSettings({ originalVolume: Number(elements.originalVolume.value) / 100 });
  });
  elements.translatedVolume.addEventListener("input", () => {
    updateRangeLabels();
    queueSettings({ translatedVolume: Number(elements.translatedVolume.value) / 100 });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "STATE_UPDATED") return;
    appState = message.state;
    render();
  });
}

async function toggleDubbing() {
  if (["connecting", "live"].includes(appState.status)) {
    elements.toggleDubbing.disabled = true;
    const response = await send({ type: "STOP_DUBBING" });
    if (!response.ok) showError(response.error);
    return;
  }

  if (!hasKey) {
    setSettingsOpen(true);
    showSaveMessage("برای شروع دوبله PAPA Dub، کلید Gemini API را وارد کنید.", "error");
    elements.apiKey.focus();
    return;
  }

  elements.errorCard.hidden = true;
  elements.toggleDubbing.disabled = true;
  const response = await send({
    type: "START_DUBBING",
    options: {
      targetLanguage: elements.targetLanguage.value,
      voiceName: elements.voiceSelect.value
    }
  });
  if (!response.ok) showError(response.error);
}

async function downloadSessionSrt() {
  const response = await send({ type: "GET_SRT_DATA" });
  if (!response?.ok || !response.srt) {
    return showError("هنوز زیرنویسی برای این نشست ثبت نشده است.");
  }
  const blob = new Blob([response.srt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = String(response.title || "papa-dub").replace(/[^\w\u0600-\u06FF\-]+/g, "-").slice(0, 42);
  link.href = url;
  link.download = `${safeName || "papa-dub"}.srt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveKey() {
  const key = elements.apiKey.value.trim();
  if (!key) return showSaveMessage("کلید را وارد کنید.", "error");
  elements.saveKey.disabled = true;
  elements.saveKey.textContent = "در حال بررسی…";
  const response = await send({
    type: "SAVE_API_KEY",
    key,
    remember: elements.rememberKey.checked
  });
  elements.saveKey.disabled = false;
  elements.saveKey.textContent = "بررسی و ذخیره";
  if (!response.ok) return showSaveMessage(response.error, "error");
  hasKey = true;
  settings.rememberKey = elements.rememberKey.checked;
  elements.apiKey.value = "";
  showSaveMessage("کلید معتبر است و با موفقیت در PAPA Dub ذخیره شد.", "success");
  renderKeyStatus();
  loadModels();
}

async function clearKey() {
  const response = await send({ type: "CLEAR_API_KEY" });
  if (!response.ok) return showSaveMessage(response.error, "error");
  hasKey = false;
  elements.apiKey.value = "";
  elements.rememberKey.checked = false;
  showSaveMessage("کلید از این مرورگر حذف شد.", "success");
  renderKeyStatus();
}

function queueSettings(patch) {
  settings = { ...settings, ...patch };
  pendingSettingsPatch = { ...pendingSettingsPatch, ...patch };
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    const queuedPatch = pendingSettingsPatch;
    pendingSettingsPatch = {};
    const response = await send({ type: "UPDATE_SETTINGS", patch: queuedPatch });
    if (!response.ok) showError(response.error);
  }, 100);
}

function applySettings() {
  elements.targetLanguage.value = settings.targetLanguage || "fa";
  elements.voiceSelect.value = settings.voiceName || "auto";
  elements.originalVolume.value = Math.round((settings.originalVolume ?? 0.2) * 100);
  elements.translatedVolume.value = Math.round((settings.translatedVolume ?? 1) * 100);
  elements.autoDucking.checked = settings.autoDucking !== false;
  elements.captionsEnabled.checked = settings.captionsEnabled !== false;
  elements.lowLatencyMode.checked = settings.lowLatencyMode !== false;
  elements.autoCatchUp.checked = settings.autoCatchUp !== false;
  populateModels();
  elements.rememberKey.checked = Boolean(settings.rememberKey);
  updateRangeLabels();
}

function render() {
  if (!appState) return;
  const active = ["connecting", "live"].includes(appState.status);
  elements.statusStrip.dataset.status = appState.status;
  elements.targetLanguage.disabled = active;
  elements.voiceSelect.disabled = active;
  elements.modelSelect.disabled = active;
  elements.toggleDubbing.disabled = false;
  elements.toggleDubbing.classList.toggle("stop", active);
  elements.buttonIcon.textContent = active ? "■" : "▶";
  elements.buttonLabel.textContent = active ? "توقف دوبله" : "شروع دوبله زنده";
  elements.transcriptCard.hidden = !active;
  elements.downloadSrt.hidden = !(appState.cueCount > 0);

  const labels = {
    idle: "آماده برای دوبله زنده",
    connecting: "در حال اتصال سریع به Gemini…",
    live: "PAPA Dub فعال است",
    error: "اتصال با خطا متوقف شد"
  };
  elements.statusText.textContent = labels[appState.status] || labels.idle;
  elements.tabHint.textContent = active && appState.tabTitle
    ? `در حال دوبله: ${truncate(appState.tabTitle, 43)}`
    : "فقط صدای همین تب پردازش می‌شود · اتصال پایدار خودکار فعال است.";

  const rate = Number(appState.playbackRate || 1);
  const rateBadge = rate > 1.02 ? ` · ${rate.toFixed(2)}×` : "";
  elements.bufferChip.textContent = `بافر ${fa.format(appState.bufferMs || 0)}ms${rateBadge}`;
  elements.originalLine.textContent = appState.latestOriginal || "در انتظار صدای گوینده…";
  elements.translationLine.textContent = appState.latestTranslation || "ترجمه اینجا نمایش داده می‌شود.";

  if (appState.status === "error" && appState.error) showError(appState.error);
  renderKeyStatus();
  updateTimerDisplay();
}

function populateModels(extra = []) {
  const seen = new Set();
  const options = [];
  const add = (id, label) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    options.push({ id, label });
  };
  KNOWN_MODELS.forEach((model) => add(model.id, model.label));
  if (settings?.model) add(settings.model, `${settings.model} — آزمایشی`);
  extra
    .filter((model) => !/transcribe/i.test(model.id))
    .forEach((model) => add(model.id, `${model.id} — آزمایشی`));

  elements.modelSelect.replaceChildren(...options.map(({ id, label }) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    return option;
  }));
  elements.modelSelect.value = settings?.model || KNOWN_MODELS[0].id;
  updateModelHint();
}

async function loadModels() {
  const response = await send({ type: "LIST_MODELS" });
  if (response.ok) populateModels(response.models || []);
}

function updateModelHint() {
  elements.modelHint.textContent = /translate/i.test(elements.modelSelect.value)
    ? "مدل مترجم پیوسته؛ ساخته‌شده برای دوبله زنده و کم‌تاخیرترین گزینه در PAPA Dub."
    : "مدل گفتگومحور؛ با دستور مفسر سریع PAPA Dub کار می‌کند.";
}

function renderKeyStatus() {
  elements.keyStatus.textContent = hasKey
    ? settings?.rememberKey ? "کلید معتبر · ذخیره روی دستگاه" : "کلید معتبر · فقط این نشست"
    : "کلید API وارد نشده";
}

function updateTimerDisplay() {
  clearInterval(timerId);
  const refresh = () => {
    const seconds = appState?.startedAt && ["connecting", "live"].includes(appState.status)
      ? Math.floor((Date.now() - appState.startedAt) / 1000)
      : 0;
    const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
    const remainder = String(seconds % 60).padStart(2, "0");
    elements.timer.textContent = `${minutes}:${remainder}`;
  };
  refresh();
  if (["connecting", "live"].includes(appState?.status)) timerId = setInterval(refresh, 1000);
}

function updateRangeLabels() {
  elements.originalValue.textContent = `${fa.format(elements.originalVolume.value)}٪`;
  elements.translatedValue.textContent = `${fa.format(elements.translatedVolume.value)}٪`;
}

function setSettingsOpen(open) {
  elements.settingsTrigger.setAttribute("aria-expanded", String(open));
  elements.settingsBody.hidden = !open;
}

function showError(text) {
  elements.errorText.textContent = text || "خطای ناشناخته";
  elements.errorCard.hidden = false;
  elements.toggleDubbing.disabled = false;
}

function showSaveMessage(text, type) {
  elements.saveMessage.textContent = text;
  elements.saveMessage.className = `save-message ${type}`;
  elements.saveMessage.hidden = false;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}
