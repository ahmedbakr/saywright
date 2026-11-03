/**
 * The local speech engine (sherpa-onnx in a child process) on real recordings
 * of people reading Arabic and English (see tests/fixtures/speech). Skipped
 * when the models aren't installed (npm run setup -- --speech installs them).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInstalled, modelById } from '../../server/speech/catalog';
import { SpeechService, toFloat, type Segment } from '../../server/speech/service';
import { charErrorRate, wordErrorRate } from '../../shared/text-compare';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../..');
const MODELS = process.env.SAYWRIGHT_SPEECH_DIR || path.join(ROOT, '.saywright', 'speech');
const SPEECH = path.resolve(here, '../fixtures/speech');
const WORKER = path.resolve(here, '../../server/speech/worker.mjs');
const omni = modelById('omnilingual-300m')!;
const ready = isInstalled(MODELS, omni) && fs.existsSync(path.join(MODELS, 'silero_vad.onnx'));

function wav(name: string): Int16Array {
  const buf = fs.readFileSync(path.join(SPEECH, name));
  const data = buf.subarray(44);
  return new Int16Array(data.buffer, data.byteOffset, data.length / 2);
}

const ARABIC = [
  { file: 'ar-fleurs-train.wav', said: 'لقد جلب لنا القطار والسيارة والعديد من أجهزة النقل الأخرى' },
  { file: 'ar-fleurs-farewell.wav', said: 'هذا لن يكون وداعاً هذا هو إغلاق فصل وبداية فصل جديد' },
  { file: 'ar-fleurs-climate.wav', said: 'في مناخ الشرق الأوسط الدافئ لم يكن للمنزل أهميّة كبيرة' },
];

describe.skipIf(!ready)('local speech engine', () => {
  const speech = new SpeechService(MODELS, WORKER, () => undefined);

  // Loading a model takes seconds on a cold machine; the tests measure hearing, so both are loaded first.
  beforeAll(async () => {
    await speech.warm('ar');
    await speech.warm('en');
  }, 120_000);
  afterAll(() => speech.stop());

  it.each(ARABIC)('hears Arabic speech: $file', async ({ file, said }) => {
    const r = await speech.transcribe(toFloat(wav(file)), 'ar');
    // Measured on 120 FLEURS clips this model gets ~5% of characters and ~16% of words wrong;
    // single short clips vary, so the bar here is looser. A word spelled slightly off still counts as a word error.
    expect(charErrorRate(said, r.text)).toBeLessThan(0.15);
    expect(wordErrorRate(said, r.text)).toBeLessThan(0.5);
    expect(r.ms).toBeLessThan(5000);
  });

  it('hears English speech', async () => {
    const r = await speech.transcribe(toFloat(wav('en-fleurs-smoke.wav')), 'en');
    expect(wordErrorRate('television reports show white smoke coming from the plant', r.text)).toBeLessThan(0.2);
  });

  it('writes an amount said in words as one, with the space before it', async () => {
    const r = await speech.transcribe(toFloat(wav('expect.wav')), 'en');
    expect(r.text).toMatch(/\bshow \$80\.80\b/i);
  });

  it('hears nothing in silence', async () => {
    const r = await speech.transcribe(toFloat(wav('silence.wav')), 'ar');
    expect(r.text.replace(/[\s.,]/g, '')).toBe('');
  });

  it('splits continuous narration into sentences, each with its place in the recording', async () => {
    // Three recordings with pauses between them, streamed in 100 ms chunks like the microphone does.
    const gap = new Int16Array(16000);
    const parts = ARABIC.map((a) => wav(a.file));
    const total = parts.reduce((n, p) => n + p.length + gap.length, gap.length);
    const audio = new Int16Array(total);
    const starts: number[] = [];
    let at = gap.length;
    for (const p of parts) {
      starts.push(at);
      audio.set(p, at);
      at += p.length + gap.length;
    }
    const segments: Segment[] = [];
    await speech.openStream('test', 'ar', (s) => segments.push(s));
    for (let i = 0; i < audio.length; i += 1600) speech.push('test', toFloat(audio.subarray(i, i + 1600)));
    await speech.close('test');
    const spoken = segments.filter((s) => s.text.trim());
    expect(spoken.length).toBe(3);
    spoken.forEach((s, i) => {
      expect(Math.abs(s.start - starts[i])).toBeLessThan(16000 * 0.6);
      expect(charErrorRate(ARABIC[i].said, s.text)).toBeLessThan(0.15);
    });
  }, 60_000);

  it('keeps working after the engine process dies, even with a command in hand', async () => {
    const internals = speech as unknown as { child: { kill: () => void } };
    internals.child.kill();
    await new Promise((r) => setTimeout(r, 200));
    const r = await speech.transcribe(toFloat(wav(ARABIC[0].file)), 'ar');
    expect(charErrorRate(ARABIC[0].said, r.text)).toBeLessThan(0.15);
    // Dies right as a command arrives: it is retried on a fresh engine, not lost.
    const asked = speech.transcribe(toFloat(wav(ARABIC[1].file)), 'ar');
    internals.child.kill();
    expect(charErrorRate(ARABIC[1].said, (await asked).text)).toBeLessThan(0.15);
  }, 120_000);
});

describe('speech catalog', () => {
  it('finds nothing in an empty folder', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-'));
    const s = new SpeechService(empty, WORKER, () => undefined);
    expect(s.status().active).toEqual({ ar: null, en: null });
    expect(s.available('ar')).toBe(false);
    expect(s.canNarrate('auto')).toBe(false);
  });
});
