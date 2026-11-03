/**
 * How accurately the studio's speech engine hears real Arabic and English,
 * measured the way it runs: whole recordings (spoken commands) and split at
 * pauses (session narration). Data: FLEURS, people reading sentences
 * (Google, CC BY 4.0), fetched by `npm run eval:speech -- --fetch`.
 *
 *   npm run eval:speech                          Arabic and English, every installed model
 *   EVAL_LANG=ar EVAL_MODEL=cohere-transcribe EVAL_LIMIT=40 npm run eval:speech
 *
 * Prints word and character error rates (after the same normalisation the
 * studio uses: Arabic letter forms folded, diacritics and punctuation
 * dropped), how many sentences came out exactly right, and the time taken.
 * Results also go to .saywright/speech-eval/. See docs/speech-accuracy.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, it } from 'vitest';
import { MODELS, isInstalled, type SpeechLang } from '../../server/speech/catalog';
import { SpeechService, toFloat, type Segment } from '../../server/speech/service';
import { editDistance, normalizeSpeech } from '../../shared/text-compare';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../..');
const HOME = path.join(ROOT, '.saywright');
const SPEECH_DIR = process.env.SAYWRIGHT_SPEECH_DIR || path.join(HOME, 'speech');
const DATA = process.env.SAYWRIGHT_FLEURS || path.join(HOME, 'fleurs');
const OUT = path.join(HOME, 'speech-eval');
const WORKER = path.resolve(here, '../../server/speech/worker.mjs');
const LIMIT = Number(process.env.EVAL_LIMIT || 120);
const LANGS = (process.env.EVAL_LANG ? [process.env.EVAL_LANG] : ['ar', 'en']) as SpeechLang[];
const FOLDER: Record<SpeechLang, string> = { ar: 'ar_eg', en: 'en_us' };

interface Item {
  id: string;
  file: string;
  ref: string;
}

/** FLEURS test sentences: every k-th, so a limit still spreads over speakers and topics. */
function items(lang: SpeechLang): Item[] {
  const dir = path.join(DATA, FOLDER[lang]);
  const tsv = path.join(dir, 'test.tsv');
  if (!fs.existsSync(tsv)) return [];
  const all = fs
    .readFileSync(tsv, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split('\t'))
    .map((c) => ({ id: c[1].replace('.wav', ''), file: path.join(dir, 'audio', 'test', c[1]), ref: c[2] }))
    .filter((x) => fs.existsSync(x.file));
  if (all.length <= LIMIT) return all;
  const k = all.length / LIMIT;
  return Array.from({ length: LIMIT }, (_, i) => all[Math.floor(i * k)]);
}

/** 16 kHz mono 16-bit WAV samples (FLEURS' format). */
function wav(file: string): Int16Array {
  const buf = fs.readFileSync(file);
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && (buf.readUInt16LE(at + 10) !== 1 || buf.readUInt32LE(at + 12) !== 16000)) throw new Error(`${file}: expected 16 kHz mono`);
    if (id === 'data') {
      const data = buf.subarray(at + 8, at + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no audio data`);
}

interface Row {
  id: string;
  ref: string;
  heard: string;
  words: number;
  wordErrors: number;
  chars: number;
  charErrors: number;
  ms: number;
  seconds: number;
}

function score(id: string, ref: string, heard: string, ms: number, seconds: number): Row {
  const r = normalizeSpeech(ref);
  const h = normalizeSpeech(heard);
  const rw = r.split(' ').filter(Boolean);
  const hw = h.split(' ').filter(Boolean);
  return { id, ref, heard, words: rw.length, wordErrors: editDistance(rw, hw), chars: r.replace(/ /g, '').length, charErrors: editDistance([...r.replace(/ /g, '')], [...h.replace(/ /g, '')]), ms, seconds };
}

function summary(rows: Row[]) {
  const sum = (k: keyof Row) => rows.reduce((s, r) => s + (r[k] as number), 0);
  return {
    sentences: rows.length,
    wordErrors: +((100 * sum('wordErrors')) / sum('words')).toFixed(1),
    charErrors: +((100 * sum('charErrors')) / sum('chars')).toFixed(1),
    exact: +((100 * rows.filter((r) => r.wordErrors === 0).length) / rows.length).toFixed(1),
    msPerSentence: Math.round(sum('ms') / rows.length),
    realTime: +(sum('ms') / 1000 / sum('seconds')).toFixed(2),
  };
}

const results: Record<string, ReturnType<typeof summary>> = {};

for (const lang of LANGS) {
  const list = items(lang);
  const models = MODELS.filter((m) => m.langs.includes(lang) && isInstalled(SPEECH_DIR, m) && (!process.env.EVAL_MODEL || m.id === process.env.EVAL_MODEL));
  describe.skipIf(!list.length || !models.length)(`${lang === 'ar' ? 'Arabic' : 'English'} (${list.length} FLEURS sentences)`, () => {
    for (const model of models) {
      const speech = new SpeechService(SPEECH_DIR, WORKER, () => undefined, () => ({ [lang]: model.id }));
      afterAll(() => speech.stop());

      it(`${model.id}: whole recordings (commands)`, async () => {
        const rows: Row[] = [];
        for (const it of list) {
          const pcm = wav(it.file);
          const t = performance.now();
          const r = await speech.transcribe(toFloat(pcm), lang);
          rows.push(score(it.id, it.ref, r.text, performance.now() - t, pcm.length / 16000));
        }
        report(`${model.id}-${lang}-whole`, rows);
      });

      it(`${model.id}: split at pauses (narration)`, async () => {
        const rows: Row[] = [];
        for (const it of list) {
          const pcm = wav(it.file);
          // As the microphone sends it: 100 ms at a time, with a second of quiet after.
          const audio = new Int16Array(pcm.length + 16000);
          audio.set(pcm);
          const heard: Segment[] = [];
          const t = performance.now();
          await speech.openStream(`eval-${it.id}`, lang, (s) => heard.push(s));
          for (let i = 0; i < audio.length; i += 1600) speech.push(`eval-${it.id}`, toFloat(audio.subarray(i, i + 1600)));
          await speech.close(`eval-${it.id}`);
          rows.push(score(it.id, it.ref, heard.map((s) => s.text).join(' '), performance.now() - t, pcm.length / 16000));
        }
        report(`${model.id}-${lang}-split`, rows);
      });
    }
  });
}

function report(name: string, rows: Row[]): void {
  const s = summary(rows);
  results[name] = s;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ summary: s, rows }, null, 1));
  console.log(`${name.padEnd(32)} word errors ${String(s.wordErrors).padStart(5)}%  characters ${String(s.charErrors).padStart(5)}%  exact ${String(s.exact).padStart(5)}%  ${s.msPerSentence} ms per sentence (${s.realTime}× real time)`);
}

afterAll(() => {
  if (Object.keys(results).length) console.table(results);
});
