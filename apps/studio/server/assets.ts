/**
 * Models the studio's page runs itself, downloaded once into the data folder and served at /models/:
 *
 *   moonshine/tiny/*.onnx     Moonshine tiny (English, MIT, 28 MB): voice commands understood in the browser,
 *                             without the browser's own recogniser. Without it, that recogniser alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { download } from './download.ts';

// Taken from the @moonshine-ai/moonshine-js package on the npm registry, so it downloads wherever npm works.
const MOONSHINE_TGZ = 'https://registry.npmjs.org/@moonshine-ai/moonshine-js/-/moonshine-js-0.1.29.tgz';
// Checked against this before it is used.
const MOONSHINE_SHA256 = '864e17a00ed494857c71693e835306fa038e0f82002c76e3056d67d574e1c2d8';
const MOONSHINE_FILES: Record<string, { name: string; size: number }> = {
  'package/dist/model/tiny/quantized/encoder_model.onnx': { name: 'encoder_model.onnx', size: 7_937_661 },
  'package/dist/model/tiny/quantized/decoder_model_merged.onnx': { name: 'decoder_model_merged.onnx', size: 20_243_286 },
};

export const modelsDir = (dataDir: string): string => path.join(dataDir, 'models');
const moonshineDir = (dataDir: string): string => path.join(modelsDir(dataDir), 'moonshine', 'tiny');

export function browserSpeechReady(dataDir: string): boolean {
  return Object.values(MOONSHINE_FILES).every((f) => fs.statSync(path.join(moonshineDir(dataDir), f.name), { throwIfNoEntry: false })?.size === f.size);
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
