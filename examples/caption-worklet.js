'use strict';

// Only receives audio routed from the video element's captured media stream.
class StreamCaptionProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.samples = new Int16Array(16000 * 4);
    this.offset = 0;
    this.filled = 0;
    this.sinceWindow = 0;
    this.emitted = false;
    this.hopSamples = options?.processorOptions?.hopSeconds === 1 ? 16000 : 32000;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.port.onmessage = event => {
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.hopSeconds === 1 || data.hopSeconds === 2) this.hopSamples = data.hopSeconds * 16000;
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] || 0;
      this.sum += mono / channels.length;
      this.count++;
      this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.samples[this.offset] = Math.round(value * 32767);
        this.offset = (this.offset + 1) % this.samples.length;
        this.filled = Math.min(this.filled + 1, this.samples.length);
        this.sinceWindow++;
        this.sum = 0;
        this.count = 0;
        if (this.filled === this.samples.length && (!this.emitted || this.sinceWindow >= this.hopSamples)) {
          // Always retain four seconds, including the first window. Hop changes
          // apply relative to the last emission: an overdue shorter hop emits
          // on this fresh sample, never by replaying a previous output window.
          const output = new Int16Array(this.samples.length);
          output.set(this.samples.subarray(this.offset));
          output.set(this.samples.subarray(0, this.offset), this.samples.length - this.offset);
          this.port.postMessage({ pcm: output.buffer, endTime: (currentFrame + i + 1) / sampleRate }, [output.buffer]);
          this.sinceWindow = 0;
          this.emitted = true;
        }
      }
    }
    return true;
  }
}
registerProcessor('stream-captions', StreamCaptionProcessor);
