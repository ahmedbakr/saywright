/**
 * Speech models the studio can run on this computer (via sherpa-onnx), and the
 * ones it uses by default. The choice comes from measurements on real and
 * synthetic Arabic and English speech: see docs/speech-accuracy.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SpeechLang } from '../../shared/api.ts';
import LIST from './models.json' with { type: 'json' };

export type { SpeechLang };

export interface SpeechModel {
  id: string;
  label: string;
  /** Languages it is chosen for. */
  langs: SpeechLang[];
  /** Release asset at github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models (a .tar.bz2). */
  archive: string;
  /** The archive's SHA-256: a download that differs is thrown away before it is unpacked. */
  sha256: string;
  /** Download size, for the install button. */
  sizeMb: number;
  /** Files that must exist once installed (relative to the model folder). */
  files: string[];
  /** sherpa-onnx OfflineModelConfig for the model folder. */
  config: (dir: string) => Record<string, unknown>;
  /** Per-request options (stream.setOption). */
  options?: (lang: SpeechLang) => Record<string, string>;
  /** Silence added after each piece of speech, in seconds (default 0.25): some models drop the last word without enough. */
  tail?: number;
  /** Longest stretch it transcribes well in one go, in seconds; longer audio is split at pauses. */
  maxSeconds: number;
  /** Installed by `npm run setup`. */
  default: boolean;
  /** Words it gets wrong per hundred, per language, measured on real read speech (FLEURS): see docs/speech-accuracy.md. */
  wordErrors: Partial<Record<SpeechLang, number>>;
}

export const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
/** The voice-activity model narration is cut into sentences with, checked like the models' archives. */
export const VAD_URL = `${RELEASE}/silero_vad.onnx`;
export const VAD_SHA256 = '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6';

/** How each model is run (the list itself, with each archive's SHA-256, is models.json). */
const RUN: Record<string, Pick<SpeechModel, 'config' | 'options' | 'tail'>> = {
  'omnilingual-300m': {
    config: (dir) => ({ omnilingual: { model: path.join(dir, 'model.int8.onnx') }, tokens: path.join(dir, 'tokens.txt') }),
  },
  'parakeet-en': {
    config: (dir) => ({
      transducer: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), joiner: path.join(dir, 'joiner.int8.onnx') },
      tokens: path.join(dir, 'tokens.txt'),
      modelType: 'nemo_transducer',
    }),
  },
  'cohere-transcribe': {
    config: (dir) => ({
      cohereTranscribe: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), usePunct: 1, useItn: 1 },
      tokens: path.join(dir, 'tokens.txt'),
    }),
    options: (lang) => ({ language: lang }),
    // Without a second of silence after the speech it cuts the last word short ("كبيرة" → "كب").
    tail: 1,
  },
};

/** In the order to suggest installing them: the small multilingual default first. */
export const MODELS: SpeechModel[] = (LIST as Omit<SpeechModel, 'config' | 'options' | 'tail'>[]).map((m) => ({ ...m, ...RUN[m.id] }));

export function modelById(id: string): SpeechModel | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelDir(root: string, m: SpeechModel): string {
  return path.join(root, m.archive);
}

export function isInstalled(root: string, m: SpeechModel): boolean {
  return m.files.every((f) => {
    try {
      return fs.statSync(path.join(modelDir(root, m), f)).size > 0;
    } catch {
      return false;
    }
  });
}

/**
 * The best installed model for a language. Measured on real speech (FLEURS):
 * Arabic: Cohere 9.1% word errors, Omnilingual 15.8% (2× faster, 6× smaller);
 * English: Parakeet 6.2% (and the fastest), Cohere 6.0%, Omnilingual 20.5%.
 */
export function pickModel(root: string, lang: SpeechLang, preferred?: string | null): SpeechModel | null {
  const pref = preferred ? modelById(preferred) : undefined;
  if (pref && pref.langs.includes(lang) && isInstalled(root, pref)) return pref;
  const ranked = lang === 'en' ? ['parakeet-en', 'cohere-transcribe', 'omnilingual-300m'] : ['cohere-transcribe', 'omnilingual-300m'];
  for (const id of ranked) {
    const m = modelById(id);
    if (m && isInstalled(root, m)) return m;
  }
  return null;
}

/** A model to run, with its per-request options. */
interface Pass {
  model: SpeechModel;
  options: Record<string, string>;
}

/**
 * How to transcribe narration. One language: its best model. Both languages:
 * the multilingual model first (it hears Arabic, English and both mixed in one
 * sentence); when what it heard is clearly one language and a better model for
 * that language is installed, that sentence is transcribed again with it.
 */
export function narrationPlan(root: string, mode: SpeechLang | 'auto', preferred: Partial<Record<SpeechLang, string | null>> = {}): { primary: Pass; arabic?: Pass; latin?: Pass } | null {
  const pass = (m: SpeechModel | null, lang: SpeechLang): Pass | undefined => (m ? { model: m, options: m.options?.(lang) ?? {} } : undefined);
  if (mode !== 'auto') {
    const p = pass(pickModel(root, mode, preferred[mode]), mode);
    return p ? { primary: p } : null;
  }
  const omni = modelById('omnilingual-300m')!;
  const primary = isInstalled(root, omni) ? pass(omni, 'ar') : pass(pickModel(root, 'ar', preferred.ar), 'ar');
  if (!primary) return null;
  const arabic = pass(pickModel(root, 'ar', preferred.ar), 'ar');
  const latin = pass(pickModel(root, 'en', preferred.en), 'en');
  return {
    primary,
    arabic: arabic && arabic.model.id !== primary.model.id ? arabic : undefined,
    latin: latin && latin.model.id !== primary.model.id ? latin : undefined,
  };
}
