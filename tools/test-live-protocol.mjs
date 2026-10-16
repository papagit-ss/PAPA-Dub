import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(root, "offscreen.js"), "utf8");
const context = {
  chrome: {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async () => ({ ok: true })
    }
  },
  console,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout
};

vm.createContext(context);
vm.runInContext(source, context, { filename: "offscreen.js" });

const message = context.buildSetupMessage("fa", "gemini-3.5-live-translate-preview", true, "Aoede", "resume-token-123");
const setup = message.setup;
const generation = setup.generationConfig;

assert.equal(setup.model, "models/gemini-3.5-live-translate-preview");
assert.deepEqual([...generation.responseModalities], ["AUDIO"]);
assert.equal(generation.translationConfig.targetLanguageCode, "fa");
assert.equal(generation.translationConfig.echoTargetLanguage, false);
assert.equal(generation.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Aoede");
assert.equal(setup.sessionResumption.handle, "resume-token-123");
assert.ok(setup.inputAudioTranscription);
assert.ok(setup.outputAudioTranscription);
assert.ok(setup.realtimeInputConfig);
assert.equal(setup.realtimeInputConfig.activityHandling, "NO_INTERRUPTION");
assert.equal(setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 240);
assert.equal("inputAudioTranscription" in generation, false);
assert.equal("outputAudioTranscription" in generation, false);

console.log("PAPA Dub Pro v0.5.0 setup payload verified (VAD, VoiceConfig, SessionResumption).");

const agent = context.buildSetupMessage("fa", "gemini-3.8-live", true, "auto", "").setup;
assert.equal(agent.model, "models/gemini-3.8-live");
assert.equal("translationConfig" in agent.generationConfig, false);
assert.equal("speechConfig" in agent.generationConfig, false);
assert.match(agent.systemInstruction.parts[0].text, /PAPA Dub/);
assert.match(agent.systemInstruction.parts[0].text, /Persian/);
assert.ok(agent.inputAudioTranscription && agent.outputAudioTranscription);

assert.equal(context.playbackRateFor(0), 1);
assert.equal(context.playbackRateFor(0.35), 1);
assert.ok(context.playbackRateFor(1.2) > 1.15 && context.playbackRateFor(1.2) < 1.45);
assert.equal(context.playbackRateFor(30), 1.45);

console.log("All PAPA Dub v0.5.0 protocol and playback tests passed.");

assert.equal(context.captionDelayMsFor(10.0, 10.0, true), 0);
assert.equal(context.captionDelayMsFor(10.0, 10.01, true), 0);
assert.equal(context.captionDelayMsFor(10.0, 11.25, true), 1250);
assert.equal(context.captionDelayMsFor(10.0, 11.25, false), 0);
assert.equal(context.captionDelayMsFor(10.0, 25.0, true), 5000);
console.log("Audio-synced caption scheduling delay calculations verified.");
