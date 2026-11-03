/**
 * On-device speech recognition with Moonshine tiny (English, MIT licence),
 * run by onnxruntime-web. Audio never leaves the computer.
 *
 * Besides free transcription, it can score how well a given sentence explains
 * the audio (teacher-forced log-likelihood). The studio uses that to rescue
 * short commands ("undo", "keep it") that free decoding often gets wrong, and
 * to choose between this model's transcript and the browser's.
 */
import * as ort from 'onnxruntime-web/wasm';
import llamaTokenizer from 'llama-tokenizer-js';

const LAYERS = 6;
const HEADS = 8;
const HEAD_DIM = 36;
const BOS = 1;
const EOS = 2;
export const SAMPLE_RATE = 16000;

export interface Transcript {
  text: string;
  /** Mean log-probability per token: closer to 0 is more confident. */
  score: number;
  /** Log-probabilities of every possible first token, for cheaply ruling out candidates. */
  first: Float32Array;
}

type Feeds = Record<string, ort.Tensor>;

function emptyPast(): Feeds {
  const past: Feeds = {};
  for (let i = 0; i < LAYERS; i++) {
    for (const a of ['decoder', 'encoder']) {
      for (const b of ['key', 'value']) past[`past_key_values.${i}.${a}.${b}`] = new ort.Tensor('float32', new Float32Array(0), [0, HEADS, 1, HEAD_DIM]);
    }
  }
  return past;
}

const ids = (tokens: number[]) => new ort.Tensor('int64', BigInt64Array.from(tokens.map(BigInt)), [1, tokens.length]);

/** log-softmax of one logits row, at `target` (or at the most likely token other than `exclude`). */
function logProb(row: Float32Array, target?: number, exclude = -1): { token: number; lp: number } {
  let best = 0;
  let bestValue = -Infinity;
  let max = -Infinity;
  for (let k = 0; k < row.length; k++) {
    if (row[k] > max) max = row[k];
    if (k !== exclude && row[k] > bestValue) {
      bestValue = row[k];
      best = k;
    }
  }
  let z = 0;
  for (let k = 0; k < row.length; k++) z += Math.exp(row[k] - max);
  const t = target ?? best;
  return { token: t, lp: row[t] - max - Math.log(z) };
}

function logSoftmax(row: Float32Array): Float32Array {
  let max = -Infinity;
  for (let k = 0; k < row.length; k++) if (row[k] > max) max = row[k];
  let z = 0;
  for (let k = 0; k < row.length; k++) z += Math.exp(row[k] - max);
  const lz = max + Math.log(z);
  const out = new Float32Array(row.length);
  for (let k = 0; k < row.length; k++) out[k] = row[k] - lz;
  return out;
}

/** Token ids of a sentence as the model would write it, starting with BOS. */
function encodeText(text: string): number[] {
  const toks = llamaTokenizer.encode(moonshineStyle(text)) as number[];
  if (toks[0] !== BOS) toks.unshift(BOS);
  return toks;
}

/** How the model writes sentences: capitalised, with closing punctuation. */
function moonshineStyle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return t;
  const cap = t[0].toUpperCase() + t.slice(1);
  if (/[.?!]$/.test(cap)) return cap;
  return /^(why|what|where|when|who|how|is|are|can|could|does|do|should|which)\b/i.test(cap) ? `${cap}?` : `${cap}.`;
}

export class Moonshine {
  private encoder: ort.InferenceSession | null = null;
  private decoder: ort.InferenceSession | null = null;

  /** `wasmPaths`: where onnxruntime's .wasm/.mjs files are served (browser only). */
  static configure(opts: { wasmPaths?: string; threads?: number }): void {
    if (opts.wasmPaths) ort.env.wasm.wasmPaths = opts.wasmPaths;
    ort.env.wasm.numThreads = opts.threads ?? 1;
  }

  get ready(): boolean {
    return !!this.encoder && !!this.decoder;
  }

  async load(encoder: string | Uint8Array, decoder: string | Uint8Array): Promise<void> {
    const options: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    this.encoder = await ort.InferenceSession.create(encoder as never, options);
    this.decoder = await ort.InferenceSession.create(decoder as never, options);
  }

  async encode(audio: Float32Array): Promise<ort.Tensor> {
    if (!this.encoder) throw new Error('speech model not loaded');
    const out = await this.encoder.run({ input_values: new ort.Tensor('float32', audio, [1, audio.length]) });
    return out.last_hidden_state;
  }

  /**
   * Free transcription with greedy decoding and a key/value cache. With
   * `notEmpty`, the model may not stop before its first word: for audio it
   * was unsure about rather than sure was silent (see `doubtfulSilence`).
   */
  async transcribe(hidden: ort.Tensor, seconds: number, { notEmpty = false } = {}): Promise<Transcript> {
    if (!this.decoder) throw new Error('speech model not loaded');
    const maxLen = Math.max(4, Math.trunc(seconds * 6));
    let past = emptyPast();
    const tokens: number[] = [];
    let input = [BOS];
    let sum = 0;
    let first: Float32Array = new Float32Array(0);
    for (let i = 0; i < maxLen; i++) {
      const out = (await this.decoder.run({ input_ids: ids(input), encoder_hidden_states: hidden, use_cache_branch: new ort.Tensor('bool', [i > 0]), ...past })) as Feeds;
      const logits = out.logits.data as Float32Array;
      const vocab = out.logits.dims[2];
      const row = logits.subarray(logits.length - vocab);
      if (i === 0) first = logSoftmax(row);
      const { token, lp } = logProb(row, undefined, i === 0 && notEmpty ? EOS : -1);
      sum += lp;
      if (token === EOS) break;
      tokens.push(token);
      input = [token];
      // The encoder half of the cache is computed once, on the first step.
      const next: Feeds = {};
      for (const [name, value] of Object.entries(out)) {
        if (!name.startsWith('present.')) continue;
        const key = name.replace('present.', 'past_key_values.');
        next[key] = i > 0 && key.includes('.encoder.') ? past[key] : value;
      }
      past = next;
    }
    const text = tokens.length ? llamaTokenizer.decode(tokens).trim() : '';
    return { text, score: sum / (tokens.length + 1), first };
  }

  /** The model chose to say nothing, but wasn't sure: there may be words it gave up on. */
  static doubtfulSilence(t: Transcript): boolean {
    return !t.text && t.first.length > EOS && t.first[EOS] < Math.log(0.95);
  }

  /** Log-probability of the first token of `text`, from a transcript's first step: a cheap upper bound on how well it fits. */
  static firstLogProb(first: Float32Array, text: string): number {
    const toks = encodeText(text);
    return toks.length > 1 && first.length ? first[toks[1]] : -Infinity;
  }

  /** Mean log-probability of `text` given the audio, in one teacher-forced pass. */
  async score(hidden: ort.Tensor, text: string): Promise<number> {
    if (!this.decoder) throw new Error('speech model not loaded');
    const toks = encodeText(text);
    const out = await this.decoder.run({ input_ids: ids(toks), encoder_hidden_states: hidden, use_cache_branch: new ort.Tensor('bool', [false]), ...emptyPast() });
    const logits = out.logits.data as Float32Array;
    const vocab = out.logits.dims[2];
    const targets = [...toks.slice(1), EOS];
    let sum = 0;
    for (let pos = 0; pos < targets.length; pos++) sum += logProb(logits.subarray(pos * vocab, (pos + 1) * vocab), targets[pos]).lp;
    return sum / targets.length;
  }
}
