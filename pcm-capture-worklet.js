class PapaPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sourceRate = options.processorOptions?.sourceSampleRate || sampleRate;
    this.targetRate = 16000;
    // 640 samples @ 16kHz = 40ms ultra-low-latency audio frames (down from 100ms)
    this.chunkSize = options.processorOptions?.chunkSize || 640;
    this.buffer = new Int16Array(this.chunkSize);
    this.writeIndex = 0;
    this.readPos = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    const ratio = this.sourceRate / this.targetRate;
    let pos = this.readPos;

    while (pos < input.length) {
      const idx = Math.floor(pos);
      const end = Math.min(input.length, Math.ceil(pos + ratio));
      let sum = 0;
      let count = 0;
      for (let j = idx; j < end; j += 1) {
        sum += input[j];
        count += 1;
      }
      const sample = count > 0 ? sum / count : input[idx];
      const clamped = Math.max(-1, Math.min(1, sample));
      this.buffer[this.writeIndex] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.writeIndex += 1;

      if (this.writeIndex >= this.chunkSize) {
        const out = this.buffer;
        this.port.postMessage({ type: "pcm", buffer: out.buffer }, [out.buffer]);
        this.buffer = new Int16Array(this.chunkSize);
        this.writeIndex = 0;
      }

      pos += ratio;
    }

    this.readPos = pos - input.length;
    return true;
  }
}

registerProcessor("papa-pcm-capture", PapaPcmCapture);
// Backward-compatible alias
registerProcessor("nava-pcm-capture", PapaPcmCapture);
