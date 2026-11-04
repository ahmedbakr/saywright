/// <reference lib="webworker" />
/**
 * Runs the on-device speech model off the main thread, so the studio's UI stays
 * smooth while it works.
 */
import type { Tensor } from 'onnxruntime-web/wasm';
import { Moonshine, SAMPLE_RATE } from './moonshine';

type Request =
  | { type: 'load'; base: string; wasmPaths?: string }
  | { type: 'partial'; id: number; audio: Float32Array }
  /** Transcribe an utterance; its encoded audio is kept under `key` for scoring. */
  | { type: 'final'; id: number; key: number; audio: Float32Array }
  /**
   * Score sentences against an utterance sent earlier. With `prune`, only
   * those whose first word fits the audio about as well as the best one are
   * scored (each full score costs as much as a few words of transcription).
   */
  | { type: 'score'; id: number; key: number; candidates: string[]; prune?: boolean };

/** Candidates whose first token is this much less likely than the best one's are not scored (none of 336 right ones were). */
const PRUNE_MARGIN = 8;

const model = new Moonshine();
let loading: Promise<void> | null = null;
/** Encoded audio of the last few utterances. */
const recent = new Map<number, { hidden: Tensor; first: Float32Array }>();

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      if (!loading) {
        Moonshine.configure({ wasmPaths: m.wasmPaths, threads: 1 });
        const t0 = performance.now();
        loading = model.load(`${m.base}/encoder_model.onnx`, `${m.base}/decoder_model_merged.onnx`).then(() => post({ type: 'loaded', ms: Math.round(performance.now() - t0) }));
      }
      await loading;
      return;
    }
    if (!model.ready) await loading;
    const t0 = performance.now();
    if (m.type === 'score') {
      const kept = recent.get(m.key);
      if (!kept) throw new Error('audio no longer available');
      let candidates = [...new Set(m.candidates)];
      if (m.prune && candidates.length > 1) {
        const firsts = candidates.map((c) => Moonshine.firstLogProb(kept.first, c));
        const best = Math.max(...firsts);
        candidates = candidates.filter((_, i) => firsts[i] >= best - PRUNE_MARGIN);
      }
      const scores: Record<string, number> = {};
      for (const c of candidates) scores[c] = await model.score(kept.hidden, c);
      post({ type: 'score', id: m.id, scores, ms: Math.round(performance.now() - t0) });
      return;
    }
    const hidden = await model.encode(m.audio);
    const seconds = m.audio.length / SAMPLE_RATE;
    let free = await model.transcribe(hidden, seconds);
    // It stopped before saying anything but wasn't sure: ask for its best guess at the words.
    if (m.type === 'final' && Moonshine.doubtfulSilence(free)) free = { ...(await model.transcribe(hidden, seconds, { notEmpty: true })), first: free.first };
    if (m.type === 'partial') {
      post({ type: 'partial', id: m.id, text: free.text });
      return;
    }
    recent.set(m.key, { hidden, first: free.first });
    for (const k of recent.keys()) if (recent.size > 3) recent.delete(k);
    post({ type: 'final', id: m.id, text: free.text, score: free.score, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    if (m.type === 'load') loading = null;
    post({ type: 'error', id: 'id' in m ? m.id : 0, message: err instanceof Error ? err.message : String(err) });
  }
};
