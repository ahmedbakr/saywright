/**
 * Models the studio's page runs itself, downloaded once into the data folder and served at /models/:
 *
 *   hand_landmarker.task      MediaPipe's hand model (7.8 MB), for hand control (Settings → Labs). Without it the
 *                             page loads the same file from Google's servers.
 *   moonshine/tiny/*.onnx     Moonshine tiny (English, MIT, 28 MB): voice commands understood in the browser,
 *                             without the browser's own recogniser. Without it, that recogniser alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { download } from './download.ts';

const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
// Taken from the @moonshine-ai/moonshine-js package on the npm registry, so it downloads wherever npm works.
const MOONSHINE_TGZ = 'https://registry.npmjs.org/@moonshine-ai/moonshine-js/-/moonshine-js-0.1.29.tgz';
// Both files are checked against these before they are used.
const MOONSHINE_SHA256 = '864e17a00ed494857c71693e835306fa038e0f82002c76e3056d67d574e1c2d8';
const HAND_MODEL_SHA256 = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1';
const MOONSHINE_FILES: Record<string, { name: string; size: number }> = {
  'package/dist/model/tiny/quantized/encoder_model.onnx': { name: 'encoder_model.onnx', size: 7_937_661 },
  'package/dist/model/tiny/quantized/decoder_model_merged.onnx': { name: 'decoder_model_merged.onnx', size: 20_243_286 },
};

export const modelsDir = (dataDir: string): string => path.join(dataDir, 'models');
export const handModelFile = (dataDir: string): string => path.join(modelsDir(dataDir), 'hand_landmarker.task');
const moonshineDir = (dataDir: string): string => path.join(modelsDir(dataDir), 'moonshine', 'tiny');

/** A .task file is a zip archive of TFLite models: check its size and the zip signature. */
export function isHandModel(file: string): boolean {
  try {
    if (fs.statSync(file).size < 1_000_000) return false;
    const head = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    // The archive may carry a short prefix before the local file header.
    return head.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } catch {
    return false;
  }
}

export function browserSpeechReady(dataDir: string): boolean {
  return Object.values(MOONSHINE_FILES).every((f) => fs.statSync(path.join(moonshineDir(dataDir), f.name), { throwIfNoEntry: false })?.size === f.size);
}

export async function ensureHandModel(dataDir: string): Promise<void> {
  const file = handModelFile(dataDir);
  if (isHandModel(file)) return;
  const tmp = `${file}.download`;
  await download(HAND_MODEL_URL, tmp, undefined, HAND_MODEL_SHA256);
  if (!isHandModel(tmp)) {
    fs.rmSync(tmp, { force: true });
    throw new Error('The hand model download was incomplete.');
  }
  fs.renameSync(tmp, file);
}

/** Pull the wanted files out of a .tar (ustar, regular files only). */
function untar(buf: Buffer, wanted: Record<string, unknown>): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a: number, b: number) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 500);
    const name = (prefix ? `${prefix}/` : '') + field(0, 100);
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const start = off + 512;
    if (wanted[name]) out[name] = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

export async function ensureBrowserSpeech(dataDir: string): Promise<void> {
  if (browserSpeechReady(dataDir)) return;
  const dir = moonshineDir(dataDir);
  const tgz = path.join(modelsDir(dataDir), 'moonshine.tgz');
  let files: Record<string, Buffer>;
  try {
    await download(MOONSHINE_TGZ, tgz, undefined, MOONSHINE_SHA256);
    files = untar(gunzipSync(fs.readFileSync(tgz)), MOONSHINE_FILES);
  } finally {
    fs.rmSync(tgz, { force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [entry, f] of Object.entries(MOONSHINE_FILES)) {
    const data = files[entry];
    if (data?.length !== f.size) throw new Error(`The speech model file ${f.name} was missing or incomplete.`);
    fs.writeFileSync(path.join(dir, f.name), data);
  }
}
