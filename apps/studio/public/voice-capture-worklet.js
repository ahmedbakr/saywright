// Collects microphone samples (at the AudioContext rate, 16 kHz) in 32 ms blocks,
// each tagged with the audio-clock time of its last sample.
class StudioCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage({ time: currentTime + (i + 1) / sampleRate, data: this.buf.slice(0) });
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('saywright-capture', StudioCapture);
