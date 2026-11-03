/**
 * The on-device speech model on real recordings (see tests/fixtures/speech).
 * Skipped when the model hasn't been downloaded (npm run setup does it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { modelsDir } from '../../server/assets';
import { parseExpectation } from '../../src/core/commands';
import { SHORT_COMMANDS, pick, plausible, understood, type Candidate } from '../../src/core/voice/choose';
import { Moonshine, SAMPLE_RATE, type Transcript } from '../../src/core/voice/moonshine';

const here = path.dirname(fileURLToPath(import.meta.url));
// Where `npm run setup` puts it: the data folder at the repository's root (or SAYWRIGHT_HOME).
const MODEL = path.join(modelsDir(process.env.SAYWRIGHT_HOME ?? path.join(path.resolve(here, '../../../..'), '.saywright')), 'moonshine', 'tiny');
const SPEECH = path.resolve(here, '../fixtures/speech');
const ready = fs.existsSync(path.join(MODEL, 'encoder_model.onnx')) && fs.existsSync(path.join(MODEL, 'decoder_model_merged.onnx'));

function wav(name: string): Float32Array {
  const data = fs.readFileSync(path.join(SPEECH, name)).subarray(44);
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

describe.skipIf(!ready)('on-device speech recognition', () => {
  const model = new Moonshine();

  beforeAll(async () => {
    Moonshine.configure({ threads: 1 });
    await model.load(fs.readFileSync(path.join(MODEL, 'encoder_model.onnx')), fs.readFileSync(path.join(MODEL, 'decoder_model_merged.onnx')));
  }, 60_000);

  /** Transcribe like the studio does, including a second try when the model stopped before its first word. */
  async function hear(name: string) {
    const audio = wav(name);
    const hidden = await model.encode(audio);
    let t: Transcript = await model.transcribe(hidden, audio.length / SAMPLE_RATE);
    if (Moonshine.doubtfulSilence(t)) t = { ...(await model.transcribe(hidden, audio.length / SAMPLE_RATE, { notEmpty: true })), first: t.first };
    return { t, hidden };
  }

  it('transcribes a request', async () => {
    expect((await hear('make-this-bigger.wav')).t.text).toBe('Make this bigger.');
  });

  it('transcribes a question', async () => {
    expect((await hear('why.wav')).t.text).toBe('Why is the total wrong?');
  });

  it('turns an amount said in words into a check the studio can test', async () => {
    const { t } = await hear('expect.wav');
    expect(parseExpectation(t.text)?.expected).toBe('$80.80');
  });

  it('is confident about what it hears, and hears nothing real in silence', async () => {
    const { t } = await hear('keep-it.wav');
    expect(t.text).toBe('Keep it.');
    expect(plausible(t.text, t.score, true)).toBe(true);
    // Pushed for words in silence, it says the classic "You": dismissed as noise.
    const quiet = await hear('silence.wav');
    expect(plausible(quiet.t.text, quiet.t.score)).toBe(false);
  });

  it('scores the sentence that was said above one that wasn’t', async () => {
    const { hidden } = await hear('keep-it.wav');
    expect(await model.score(hidden, 'Keep it.')).toBeGreaterThan((await model.score(hidden, 'Undo.')) + 1);
  });

  it('recognises a one-word command it can’t transcribe', async () => {
    const { t, hidden } = await hear('undo.wav');
    // Free transcription mishears it…
    expect(understood(t.text)).toBe(false);
    // …but checking the audio against the studio's commands finds it.
    const firsts = SHORT_COMMANDS.map((c) => Moonshine.firstLogProb(t.first, c));
    const best = Math.max(...firsts);
    const commands = SHORT_COMMANDS.filter((_, i) => firsts[i] >= best - 8);
    expect(commands).toContain('Undo.');
    const scores: Record<string, number> = { [t.text]: t.score };
    for (const c of commands) scores[c] = await model.score(hidden, c);
    const candidates: Candidate[] = [{ text: t.text, source: 'device', rank: 0 }, ...commands.map((text): Candidate => ({ text, source: 'command', rank: 0 }))];
    expect(pick(candidates, scores)?.text).toBe('Undo.');
  });
});
