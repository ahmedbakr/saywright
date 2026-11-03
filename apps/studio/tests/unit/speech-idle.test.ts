/**
 * The speech engine holds its models (up to a few GB) only while it is used: left idle it stops, the next request
 * starts it again, and stopping for being idle isn't counted as a crash. A stand-in engine answers like the real one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODELS, modelDir } from '../../server/speech/catalog';
import { SpeechService } from '../../server/speech/service';

const FAKE_ENGINE = `
process.send({ type: 'ready', version: 'fake' });
process.on('message', (m) => {
  if (m.type === 'load') process.send({ type: 'loaded', key: m.key });
  if (m.type === 'transcribe') process.send({ type: 'result', id: m.id, text: 'make it bigger', ms: 1 });
  if (m.type === 'stream-close') process.send({ type: 'stream-closed', sid: m.sid });
});
`;

const services: SpeechService[] = [];

function setup(idleMs: number): SpeechService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-speech-'));
  // An English model "installed": its files exist.
  const model = MODELS.find((m) => m.langs.includes('en'))!;
  for (const f of model.files) {
    fs.mkdirSync(path.dirname(path.join(modelDir(root, model), f)), { recursive: true });
    fs.writeFileSync(path.join(modelDir(root, model), f), 'x');
  }
  fs.writeFileSync(path.join(root, 'silero_vad.onnx'), 'x');
  const engine = path.join(root, 'engine.mjs');
  fs.writeFileSync(engine, FAKE_ENGINE);
  const s = new SpeechService(root, engine, () => undefined, () => ({}), idleMs);
  services.push(s);
  return s;
}

const until = async (check: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
};

afterEach(() => {
  for (const s of services.splice(0)) s.stop();
});

describe('the speech engine when idle', () => {
  it('stops after a while unused, and starts again for the next request', async () => {
    const speech = setup(150);
    expect((await speech.transcribe(new Float32Array(1600), 'en')).text).toBe('make it bigger');
    expect(speech.running).toBe(true);
    expect(await until(() => !speech.running)).toBe(true);
    expect((await speech.transcribe(new Float32Array(1600), 'en')).text).toBe('make it bigger');
    expect(speech.running).toBe(true);
  });

  it('isn’t counted as a crash, however often it happens', async () => {
    const speech = setup(60);
    for (let i = 0; i < 4; i++) {
      await speech.transcribe(new Float32Array(1600), 'en');
      expect(await until(() => !speech.running)).toBe(true);
    }
    expect(speech.status().runtimeError).toBe('');
    expect(speech.status().runtime).not.toBe('failed');
  });

  it('stays up while a recording is being transcribed', async () => {
    const speech = setup(80);
    await speech.openStream('s1', 'en', () => undefined);
    await new Promise((r) => setTimeout(r, 400));
    expect(speech.running).toBe(true);
    await speech.close('s1');
    expect(await until(() => !speech.running)).toBe(true);
  });
});
