const DEFAULT_MODEL = "gemini-3.5-live-translate-preview";
const LANGUAGE_NAMES = {
  fa: "Persian (Farsi)", en: "English", ar: "Arabic", tr: "Turkish", de: "German",
  fr: "French", es: "Spanish", ru: "Russian", ja: "Japanese", ko: "Korean", zh: "Chinese"
};
const VALID_VOICES = new Set(["Puck", "Charon", "Kore", "Fenrir", "Aoede"]);
const MAX_BACKLOG_SECONDS = 4.2;
const MAX_RECONNECT_ATTEMPTS = 5;
let session = null;

// Dedicated translation models (continuous stream) use translationConfig.
// Any other Live model is a conversational agent and is driven by an interpreter prompt.
function isTranslateModel(model) {
  return /translate/i.test(model || DEFAULT_MODEL);
}

// Low-latency dynamic catch-up:
// Start accelerating gently at 0.35s backlog and scale up to 1.45x
function playbackRateFor(backlogSeconds, lowLatencyMode = true) {
  const threshold = lowLatencyMode ? 0.35 : 0.85;
  const maxRate = lowLatencyMode ? 1.45 : 1.28;
  const slope = lowLatencyMode ? 0.22 : 0.12;
  if (backlogSeconds <= threshold) return 1;
  return Math.min(maxRate, Number((1 + (backlogSeconds - threshold) * slope).toFixed(3)));
}

// Calculate exact delay (in ms) so a caption scheduled at `targetPlayTime`
// appears on screen at the exact moment its dubbed audio plays from the speaker.
function captionDelayMsFor(currentTime, targetPlayTime, syncCaptions = true) {
  if (!syncCaptions) return 0;
  const deltaSec = (Number(targetPlayTime) || 0) - (Number(currentTime) || 0);
  if (deltaSec <= 0.02) return 0;
  return Math.min(5000, Math.round(deltaSec * 1000));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "START_CAPTURE") {
    startSession(message)
      .then(() => sendResponse({ ok: true }))
      .catch(async (error) => {
        reportError(error);
        await stopSession("startup-error", false);
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }

  if (message.type === "STOP_CAPTURE") {
    stopSession(message.reason || "").then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "UPDATE_AUDIO_SETTINGS") {
    updateAudioSettings(message.settings);
    sendResponse({ ok: true });
  }
  return false;
});

async function startSession({ streamId, apiKey, targetLanguage, model, settings }) {
  await stopSession("restart", false);

  const selectedModel = model || DEFAULT_MODEL;
  const lowLatencyMode = settings?.lowLatencyMode !== false;
  const voiceName = settings?.voiceName || "auto";

  const mediaStreamPromise = navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const audioContext = new AudioContext({ latencyHint: "interactive" });
  const workletPromise = audioContext.audioWorklet.addModule("pcm-capture-worklet.js");

  session = {
    apiKey,
    targetLanguage: targetLanguage || "fa",
    mediaStream: null,
    audioContext,
    source: null,
    originalGain: null,
    translatedGain: null,
    captureNode: null,
    websocket: null,
    ready: false,
    pendingChunks: [],
    playbackHead: audioContext.currentTime,
    lastChunkStartAt: audioContext.currentTime,
    model: selectedModel,
    voiceName,
    originalVolume: Number(settings?.originalVolume ?? 0.2),
    translatedVolume: Number(settings?.translatedVolume ?? 1),
    autoDucking: settings?.autoDucking !== false,
    isDucked: false,
    duckReleaseTimer: null,
    catchUp: settings?.autoCatchUp !== false,
    lowLatencyMode,
    smartSync: settings?.smartSync !== false,
    syncCaptions: settings?.syncCaptions !== false,
    stagedOriginal: "",
    displayedOriginal: "",
    displayedTranslation: "",
    turnAudioStartAt: null,
    turnTextBuffer: "",
    turnCompleteFlag: true,
    captionTimers: new Set(),
    resumptionHandle: "",
    reconnectAttempts: 0,
    reconnectTimer: null,
    reconnecting: false,
    sources: [],
    startedAt: Date.now(),
    metricsTimer: null,
    stopping: false
  };

  const wsPromise = connectGemini();
  const [mediaStream] = await Promise.all([mediaStreamPromise, workletPromise]);

  if (!session || session.stopping) {
    for (const track of mediaStream.getTracks()) track.stop();
    return;
  }

  session.mediaStream = mediaStream;

  const source = audioContext.createMediaStreamSource(mediaStream);
  const originalGain = audioContext.createGain();
  const translatedGain = audioContext.createGain();
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  const initialOrigGain = session.autoDucking ? 1.0 : session.originalVolume;
  originalGain.gain.value = initialOrigGain;
  translatedGain.gain.value = session.translatedVolume;

  source.connect(originalGain).connect(audioContext.destination);
  translatedGain.connect(audioContext.destination);

  const captureNode = new AudioWorkletNode(audioContext, "papa-pcm-capture", {
    processorOptions: {
      sourceSampleRate: audioContext.sampleRate,
      chunkSize: lowLatencyMode ? 640 : 1280
    }
  });
  source.connect(captureNode).connect(silentGain).connect(audioContext.destination);

  session.source = source;
  session.originalGain = originalGain;
  session.translatedGain = translatedGain;
  session.captureNode = captureNode;

  captureNode.port.onmessage = ({ data }) => {
    if (!session || data?.type !== "pcm") return;
    if (!session.ready || session.websocket?.readyState !== WebSocket.OPEN) {
      if (session.pendingChunks.length < 35) session.pendingChunks.push(data.buffer);
      return;
    }
    sendPcm(data.buffer);
  };

  await wsPromise;
  session.metricsTimer = setInterval(reportMetrics, 400);
}

function connectGemini() {
  return new Promise((resolve, reject) => {
    if (!session) return reject(new Error("موتور صوت PAPA Dub آماده نیست."));

    const endpoint = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
    const websocket = new WebSocket(`${endpoint}?key=${encodeURIComponent(session.apiKey)}`);
    session.websocket = websocket;
    session.ready = false;

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("اتصال به Gemini بیش از حد طول کشید."));
      }
    }, 15000);

    websocket.onopen = () => {
      if (!session) return;
      const setupPayload = buildSetupMessage(
        session.targetLanguage,
        session.model,
        session.lowLatencyMode,
        session.voiceName,
        session.resumptionHandle
      );
      websocket.send(JSON.stringify(setupPayload));
    };

    websocket.onmessage = async ({ data }) => {
      if (!session) return;
      const text = typeof data === "string" ? data : await data.text();
      let message;
      try {
        message = JSON.parse(text);
      } catch (_) {
        return;
      }

      if (message.sessionResumptionUpdate) {
        const update = message.sessionResumptionUpdate;
        if (update.resumable && update.newHandle) {
          session.resumptionHandle = update.newHandle;
        }
      }

      if (message.goAway && !session.stopping && !session.reconnecting) {
        scheduleReconnect("go-away", 150);
        return;
      }

      if (message.setupComplete) {
        clearTimeout(timeout);
        session.ready = true;
        session.reconnectAttempts = 0;
        session.reconnecting = false;
        chrome.runtime.sendMessage({ type: "OFFSCREEN_STATUS", status: "live" }).catch(() => {});
        for (const chunk of session.pendingChunks.splice(0)) sendPcm(chunk);
        if (!settled) {
          settled = true;
          resolve();
        }
        return;
      }

      const content = message.serverContent;
      if (!content) return;

      if (content.interrupted && !isTranslateModel(session.model)) {
        clearAudioQueue();
      }

      // 1. Queue any audio chunks in this server message FIRST so we know their exact playback schedule (`chunkStartAt`)
      let firstChunkStartInMessage = null;
      for (const part of content.modelTurn?.parts || []) {
        const inline = part.inlineData || part.inline_data;
        if (inline?.data) {
          const scheduledStart = queueTranslatedAudio(inline.data);
          if (scheduledStart !== null && firstChunkStartInMessage === null) {
            firstChunkStartInMessage = scheduledStart;
          }
        }
      }

      // 2. Stage original source speech transcript:
      // Instead of flashing the new source sentence while the PREVIOUS sentence's dub is still playing,
      // align original transcript updates with the current dubbing playback head.
      const incomingOriginal = content.inputTranscription?.text || content.interimInputTranscription?.text || "";
      if (incomingOriginal) {
        session.stagedOriginal = incomingOriginal;
        const now = session.audioContext.currentTime;
        const activeBacklog = Math.max(0, session.playbackHead - now);
        // If no dub audio is currently backed up, show original right away; otherwise sync with playbackHead
        const targetTime = activeBacklog > 0.15 ? session.playbackHead : now;
        scheduleSyncedTranscript({
          original: incomingOriginal,
          targetPlayTime: targetTime,
          isFinal: Boolean(content.inputTranscription?.text)
        });
      }

      // 3. Synchronize translated caption with the exact audio playback start time of the corresponding dub chunk:
      if (content.outputTranscription?.text) {
        const now = session.audioContext.currentTime;
        if (session.turnCompleteFlag) {
          session.turnCompleteFlag = false;
          session.turnAudioStartAt = firstChunkStartInMessage ?? Math.max(now, session.lastChunkStartAt || session.playbackHead);
        }
        // Schedule this translation chunk to appear when its paired audio chunk actually starts playing
        const targetTime = firstChunkStartInMessage
          ?? session.lastChunkStartAt
          ?? session.turnAudioStartAt
          ?? Math.max(now, session.playbackHead);

        scheduleSyncedTranscript({
          original: session.stagedOriginal || undefined,
          translation: content.outputTranscription.text,
          targetPlayTime: targetTime,
          isFinal: Boolean(content.turnComplete || content.generationComplete)
        });
      }

      if (content.turnComplete || content.generationComplete) {
        session.turnCompleteFlag = true;
        session.turnAudioStartAt = null;
      }
    };

    websocket.onerror = () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error("اتصال زنده Gemini برقرار نشد."));
      }
    };

    websocket.onclose = ({ code, reason }) => {
      clearTimeout(timeout);
      if (!session || session.stopping) return;

      const fatal = code === 1007 || code === 1008 || /invalid|api key|permission|quota/i.test(reason || "");
      if (!fatal && session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delayMs = Math.min(4000, 500 * Math.pow(1.7, session.reconnectAttempts));
        scheduleReconnect(reason || `code-${code}`, delayMs);
        if (!settled) {
          settled = true;
          resolve();
        }
        return;
      }

      if (!settled) {
        settled = true;
        reject(new Error(reason || `اتصال Gemini بسته شد (${code}).`));
      } else {
        reportError(new Error(reason || `اتصال Gemini بسته شد (${code}).`));
        stopSession("connection-closed", false);
      }
    };
  });
}

// Schedules a transcript update to fire at `targetPlayTime` on the WebAudio timeline
// so the viewer sees the subtitle at the exact moment the dubbed voice speaks it.
function scheduleSyncedTranscript({ original, translation, targetPlayTime, isFinal }) {
  if (!session) return;
  const now = session.audioContext.currentTime;
  const delayMs = captionDelayMsFor(now, targetPlayTime, session.syncCaptions);

  const emit = () => {
    if (!session || session.stopping) return;
    const payload = {
      type: "OFFSCREEN_TRANSCRIPT",
      elapsedSec: Math.max(0, (Date.now() - session.startedAt) / 1000),
      isFinal: Boolean(isFinal)
    };
    if (typeof original === "string" && original) {
      session.displayedOriginal = original;
      payload.original = original;
    }
    if (typeof translation === "string" && translation) {
      session.displayedTranslation = translation;
      payload.translation = translation;
    }
    chrome.runtime.sendMessage(payload).catch(() => {});
  };

  if (delayMs <= 15) {
    emit();
    return;
  }

  const timerId = setTimeout(() => {
    session?.captionTimers.delete(timerId);
    emit();
  }, delayMs);
  session.captionTimers.add(timerId);
}

function clearCaptionTimers() {
  if (!session) return;
  for (const timerId of session.captionTimers) {
    clearTimeout(timerId);
  }
  session.captionTimers.clear();
}

function scheduleReconnect(reason, delayMs = 500) {
  if (!session || session.stopping || session.reconnecting) return;
  session.reconnecting = true;
  session.ready = false;
  session.reconnectAttempts += 1;

  chrome.runtime.sendMessage({
    type: "OFFSCREEN_STATUS",
    status: "connecting"
  }).catch(() => {});

  try { session.websocket?.close(1000, "reconnecting"); } catch (_) {}

  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = setTimeout(async () => {
    if (!session || session.stopping) return;
    try {
      await connectGemini();
    } catch (err) {
      if (!session || session.stopping) return;
      if (session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        session.reconnecting = false;
        scheduleReconnect("retry", 1200 * session.reconnectAttempts);
      } else {
        reportError(err);
        stopSession("reconnect-failed", false);
      }
    }
  }, delayMs);
}

function buildSetupMessage(
  targetLanguage,
  model = DEFAULT_MODEL,
  lowLatencyMode = true,
  voiceName = "auto",
  resumptionHandle = ""
) {
  const lang = targetLanguage || "fa";

  const realtimeInputConfig = {
    automaticActivityDetection: {
      disabled: false,
      startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
      endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
      prefixPaddingMs: lowLatencyMode ? 120 : 200,
      silenceDurationMs: lowLatencyMode ? 240 : 450
    },
    activityHandling: "NO_INTERRUPTION",
    turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY"
  };

  const sessionResumption = resumptionHandle ? { handle: resumptionHandle } : {};
  const speechConfig = VALID_VOICES.has(voiceName)
    ? { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
    : undefined;

  if (isTranslateModel(model)) {
    const generationConfig = {
      responseModalities: ["AUDIO"],
      translationConfig: {
        targetLanguageCode: lang === "zh" ? "zh-Hans" : lang,
        echoTargetLanguage: false
      }
    };
    if (speechConfig) generationConfig.speechConfig = speechConfig;

    return {
      setup: {
        model: `models/${model}`,
        generationConfig,
        realtimeInputConfig,
        sessionResumption,
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };
  }

  const name = LANGUAGE_NAMES[lang] || lang;
  const generationConfig = { responseModalities: ["AUDIO"] };
  if (speechConfig) generationConfig.speechConfig = speechConfig;

  return {
    setup: {
      model: `models/${model}`,
      generationConfig,
      realtimeInputConfig,
      sessionResumption,
      systemInstruction: {
        parts: [{
          text: `You are PAPA Dub, an ultra-low-latency simultaneous dubbing interpreter. Translate incoming speech into natural, concise ${name} immediately phrase-by-phrase so the dub stays synced with the speaker. Keep translations compact and fast. Output ONLY the spoken translation. Never answer questions, comment, or explain. If the speech is already in ${name}, stay silent.`
        }]
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  };
}

function sendPcm(arrayBuffer) {
  if (!session?.ready || session.websocket?.readyState !== WebSocket.OPEN) return;
  session.websocket.send(JSON.stringify({
    realtimeInput: {
      audio: {
        data: arrayBufferToBase64(arrayBuffer),
        mimeType: "audio/pcm;rate=16000"
      }
    }
  }));
}

function syncDuckingState() {
  if (!session || !session.originalGain) return;
  const now = session.audioContext.currentTime;
  const hasActiveDub = session.sources.length > 0 && session.playbackHead > now + 0.02;

  if (!session.autoDucking) {
    clearTimeout(session.duckReleaseTimer);
    session.isDucked = false;
    session.originalGain.gain.setTargetAtTime(session.originalVolume, now, 0.03);
    return;
  }

  if (hasActiveDub) {
    clearTimeout(session.duckReleaseTimer);
    if (!session.isDucked) {
      session.isDucked = true;
      session.originalGain.gain.setTargetAtTime(session.originalVolume, now, 0.035);
    }
  } else if (session.isDucked) {
    clearTimeout(session.duckReleaseTimer);
    session.duckReleaseTimer = setTimeout(() => {
      if (!session || !session.originalGain) return;
      const currentNow = session.audioContext.currentTime;
      if (session.sources.length === 0) {
        session.isDucked = false;
        session.originalGain.gain.setTargetAtTime(1.0, currentNow, 0.18);
      }
    }, 240);
  }
}

function clearAudioQueue() {
  if (!session) return;
  for (const item of session.sources) {
    try { item.node.stop(); } catch (_) {}
  }
  session.sources = [];
  session.playbackHead = session.audioContext.currentTime;
  session.lastChunkStartAt = session.playbackHead;
  clearCaptionTimers();
  syncDuckingState();
}

function enforceSmartSync() {
  if (!session || !session.smartSync) return;
  const now = session.audioContext.currentTime;
  const backlog = session.playbackHead - now;
  if (backlog <= MAX_BACKLOG_SECONDS || session.sources.length <= 2) return;

  const unplayed = session.sources.filter((item) => item.startAt > now + 0.04);
  if (!unplayed.length) return;

  clearAudioQueue();
}

function queueTranslatedAudio(base64) {
  if (!session) return null;
  const bytes = base64ToBytes(base64);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (sampleCount <= 0) return null;

  const audioBuffer = session.audioContext.createBuffer(1, sampleCount, 24000);
  const channel = audioBuffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < sampleCount; i += 1) {
    channel[i] = view.getInt16(i * 2, true) / 32768;
  }

  enforceSmartSync();

  const now = session.audioContext.currentTime;
  const backlog = Math.max(0, session.playbackHead - now);
  const rate = session.catchUp ? playbackRateFor(backlog, session.lowLatencyMode) : 1;

  const node = session.audioContext.createBufferSource();
  node.buffer = audioBuffer;
  node.playbackRate.value = rate;
  node.connect(session.translatedGain);

  const startAt = Math.max(now + 0.01, session.playbackHead);
  const duration = audioBuffer.duration / rate;
  const entry = { node, startAt, endAt: startAt + duration };
  session.sources.push(entry);

  node.onended = () => {
    if (!session) return;
    const idx = session.sources.indexOf(entry);
    if (idx !== -1) session.sources.splice(idx, 1);
    syncDuckingState();
  };

  node.start(startAt);
  session.lastChunkStartAt = startAt;
  session.playbackHead = startAt + duration;
  syncDuckingState();
  return startAt;
}

function updateAudioSettings(settings = {}) {
  if (!session) return;
  if ("autoCatchUp" in settings) session.catchUp = settings.autoCatchUp !== false;
  if ("lowLatencyMode" in settings) session.lowLatencyMode = settings.lowLatencyMode !== false;
  if ("smartSync" in settings) session.smartSync = settings.smartSync !== false;
  if ("autoDucking" in settings) session.autoDucking = settings.autoDucking !== false;
  if ("syncCaptions" in settings) session.syncCaptions = settings.syncCaptions !== false;
  if ("voiceName" in settings) session.voiceName = settings.voiceName || "auto";

  if (Number.isFinite(Number(settings.originalVolume))) {
    session.originalVolume = Number(settings.originalVolume);
  }
  if (Number.isFinite(Number(settings.translatedVolume))) {
    session.translatedVolume = Number(settings.translatedVolume);
    session.translatedGain?.gain.setTargetAtTime(session.translatedVolume, session.audioContext.currentTime, 0.025);
  }
  syncDuckingState();
}

function reportMetrics() {
  if (!session) return;
  const seconds = Math.max(0, session.playbackHead - session.audioContext.currentTime);
  const rate = session.catchUp ? playbackRateFor(seconds, session.lowLatencyMode) : 1;
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_METRICS",
    bufferMs: Math.round(seconds * 1000),
    playbackRate: rate
  }).catch(() => {});
}

async function stopSession(reason = "", notify = true) {
  if (!session) return;
  const current = session;
  session = null;
  current.stopping = true;
  clearInterval(current.metricsTimer);
  clearTimeout(current.reconnectTimer);
  clearTimeout(current.duckReleaseTimer);
  for (const timerId of current.captionTimers) clearTimeout(timerId);
  current.captionTimers.clear();

  try { current.websocket?.close(1000, reason.slice(0, 100)); } catch (_) {}
  for (const track of current.mediaStream?.getTracks() || []) track.stop();
  try { current.captureNode?.disconnect(); } catch (_) {}
  try { await current.audioContext?.close(); } catch (_) {}

  if (notify) {
    const durationSeconds = Math.round((Date.now() - current.startedAt) / 1000);
    chrome.runtime.sendMessage({ type: "OFFSCREEN_STOPPED", durationSeconds }).catch(() => {});
  }
}

function reportError(error) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_ERROR",
    error: String(error?.message || error)
  }).catch(() => {});
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
