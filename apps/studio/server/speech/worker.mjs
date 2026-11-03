// Speech recognition, in its own process so heavy decoding never stalls the
// studio server. Talks to the parent over IPC (advanced serialization, so
// Float32Arrays cross without copying into JSON).
//
//   → { type: 'load', key, config, tail? }               create a recognizer; tail: seconds of silence after speech
//   → { type: 'transcribe', id, key, samples, options, priority }
//   ← { type: 'result', id, text, ms } | { type: 'error', id, message }
//   → { type: 'stream-open', sid, plan, vad }             live narration; plan = { primary, arabic?, latin? },
//                                                           each { key, options }: see narrationPlan in catalog.ts
//   → { type: 'stream-push', sid, samples }              16 kHz float samples
//   → { type: 'stream-close', sid }
//   ← { type: 'segment', sid, start, end, text, ms, key } start/end in samples; key: the model that wrote it
//   ← { type: 'stream-closed', sid }
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sherpa;
try {
  sherpa = require('sherpa-onnx-node');
} catch (err) {
  process.send?.({ type: 'fatal', message: `Speech runtime unavailable: ${err?.message ?? err}` });
  process.exit(1);
}

const RATE = 16000;
const recognizers = new Map(); // key -> Promise<OfflineRecognizer>
const configs = new Map();
const tails = new Map(); // key -> seconds of silence to add after the speech

function recognizer(key) {
  let r = recognizers.get(key);
  if (!r) {
    const config = configs.get(key);
    if (!config) return Promise.reject(new Error(`Model ${key} is not loaded`));
    r = sherpa.OfflineRecognizer.createAsync(config);
    recognizers.set(key, r);
    r.catch(() => recognizers.delete(key));
  }
  return r;
}

// One decode at a time keeps latency predictable; a spoken command jumps the queue ahead of narration.
const queue = [];
let busy = false;

function enqueue(job, priority) {
  return new Promise((resolve, reject) => {
    const item = { job, resolve, reject, priority };
    if (priority === 'high') {
      const i = queue.findIndex((q) => q.priority !== 'high');
      queue.splice(i < 0 ? queue.length : i, 0, item);
    } else queue.push(item);
    void pump();
  });
}

async function pump() {
  if (busy) return;
  const item = queue.shift();
  if (!item) return;
  busy = true;
  try {
    item.resolve(await item.job());
  } catch (err) {
    item.reject(err);
  } finally {
    busy = false;
    void pump();
  }
}

/** Silence around the speech helps models that clip word edges: a quarter second before, and what the model needs after. */
function padded(samples, tail = 0.25) {
  const lead = Math.round(RATE * 0.25);
  const out = new Float32Array(lead + samples.length + Math.round(RATE * tail));
  out.set(samples, lead);
  return out;
}

/** Some models write an amount straight after the word before it (“should show$80.80”): put the space back. */
const tidy = (text) => text.replace(/(\p{L})([$€£])(?=\d)/gu, '$1 $2');

async function decode(key, samples, options) {
  const rec = await recognizer(key);
  const stream = rec.createStream();
  for (const [k, v] of Object.entries(options ?? {})) stream.setOption(k, String(v));
  stream.acceptWaveform({ sampleRate: RATE, samples: padded(samples, tails.get(key)) });
  const t = performance.now();
  const result = await rec.decodeAsync(stream);
  return { text: tidy(String(result?.text ?? '').trim()), ms: Math.round(performance.now() - t) };
}

// ---- live narration: voice activity detection, then a decode per sentence ----

const streams = new Map(); // sid -> { vad, plan, pending: Promise[], window: Float32Array, fill, recent: Recent }

/**
 * The last half minute of a stream's audio. The voice detector trims a
 * sentence to where it heard speech, which can cut a soft last syllable
 * ("ة", a trailing "s"); each sentence is decoded with the real audio just
 * around it instead.
 */
class Recent {
  constructor(seconds) {
    this.buf = new Float32Array(RATE * seconds);
    this.total = 0; // samples ever pushed: the same count the voice detector's positions use
  }
  push(x) {
    for (let i = 0; i < x.length; ) {
      const at = this.total % this.buf.length;
      const n = Math.min(x.length - i, this.buf.length - at);
      this.buf.set(x.subarray(i, i + n), at);
      i += n;
      this.total += n;
    }
  }
  slice(from, to) {
    from = Math.max(from, this.total - this.buf.length, 0);
    to = Math.min(to, this.total);
    const out = new Float32Array(Math.max(0, to - from));
    for (let k = from, o = 0; k < to; ) {
      const at = k % this.buf.length;
      const n = Math.min(to - k, this.buf.length - at);
      out.set(this.buf.subarray(at, at + n), o);
      o += n;
      k += n;
    }
    return out;
  }
}

/** Real audio kept around each sentence: a little before, and more after (it ends after 0.45 s of quiet, so that much has arrived). */
const BEFORE = Math.round(RATE * 0.2);
const AFTER = Math.round(RATE * 0.4);

/** Arabic or Latin letters: which one most of the text is written in. */
function script(text) {
  const ar = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (ar + latin < 3) return null;
  if (ar >= latin * 3) return 'arabic';
  if (latin >= ar * 3) return 'latin';
  return null; // mixed: the multilingual model's own words are best
}

/** Transcribe one sentence by the plan: the primary model, then the better model for its language when there is one. */
async function decodePlanned(plan, samples) {
  const first = await decode(plan.primary.key, samples, plan.primary.options);
  const which = script(first.text);
  const better = which && plan[which];
  if (!better) return { ...first, key: plan.primary.key };
  try {
    const second = await decode(better.key, samples, better.options);
    if (second.text) return { text: second.text, ms: first.ms + second.ms, key: better.key };
  } catch {
    /* keep the first transcript */
  }
  return { ...first, key: plan.primary.key };
}

function openStream(m) {
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: m.vad,
        threshold: 0.45,
        minSilenceDuration: 0.45,
        minSpeechDuration: 0.2,
        maxSpeechDuration: m.maxSpeech ?? 12,
        windowSize: 512,
      },
      sampleRate: RATE,
      debug: false,
      numThreads: 1,
    },
    60,
  );
  streams.set(m.sid, { vad, plan: m.plan, pending: [], window: new Float32Array(512), fill: 0, recent: new Recent(30) });
}

function drain(sid, s) {
  while (!s.vad.isEmpty()) {
    // A copy: the default view points into native memory that pop() frees.
    const seg = s.vad.front(false);
    s.vad.pop();
    const start = seg.start;
    const end = start + seg.samples.length;
    const around = s.recent.slice(start - BEFORE, end + AFTER);
    const samples = around.length >= seg.samples.length ? around : seg.samples;
    const p = enqueue(() => decodePlanned(s.plan, samples), 'low')
      .then((r) => process.send?.({ type: 'segment', sid, start, end, text: r.text, ms: r.ms, key: r.key }))
      .catch((err) => process.send?.({ type: 'segment', sid, start, end, text: '', ms: 0, error: String(err?.message ?? err) }));
    s.pending.push(p);
  }
}

function pushStream(m) {
  const s = streams.get(m.sid);
  if (!s) return;
  // The VAD wants exact 512-sample windows.
  const x = m.samples;
  let i = 0;
  while (i < x.length) {
    const take = Math.min(512 - s.fill, x.length - i);
    s.window.set(x.subarray(i, i + take), s.fill);
    s.fill += take;
    i += take;
    if (s.fill === 512) {
      s.vad.acceptWaveform(s.window);
      s.recent.push(s.window);
      s.fill = 0;
    }
  }
  drain(m.sid, s);
}

async function closeStream(m) {
  const s = streams.get(m.sid);
  if (!s) return process.send?.({ type: 'stream-closed', sid: m.sid });
  if (s.fill) {
    const rest = new Float32Array(512);
    rest.set(s.window.subarray(0, s.fill));
    s.vad.acceptWaveform(rest);
    s.recent.push(rest);
  }
  s.vad.flush();
  drain(m.sid, s);
  await Promise.allSettled(s.pending);
  streams.delete(m.sid);
  process.send?.({ type: 'stream-closed', sid: m.sid });
}

process.on('message', (m) => {
  switch (m?.type) {
    case 'load':
      configs.set(m.key, m.config);
      if (typeof m.tail === 'number') tails.set(m.key, m.tail);
      recognizer(m.key).then(
        () => process.send?.({ type: 'loaded', key: m.key }),
        (err) => process.send?.({ type: 'load-error', key: m.key, message: String(err?.message ?? err) }),
      );
      break;
    case 'transcribe':
      enqueue(() => decode(m.key, m.samples, m.options), m.priority === 'low' ? 'low' : 'high').then(
        (r) => process.send?.({ type: 'result', id: m.id, ...r }),
        (err) => process.send?.({ type: 'error', id: m.id, message: String(err?.message ?? err) }),
      );
      break;
    case 'stream-open':
      try {
        openStream(m);
      } catch (err) {
        process.send?.({ type: 'stream-error', sid: m.sid, message: String(err?.message ?? err) });
      }
      break;
    case 'stream-push':
      pushStream(m);
      break;
    case 'stream-close':
      void closeStream(m);
      break;
  }
});

process.on('disconnect', () => process.exit(0));
process.send?.({ type: 'ready', version: sherpa.version });
