// `npm run eval:speech`: measure how accurately the studio's speech engine hears Arabic and English.
//
// It runs the installed models on FLEURS, people reading sentences (Google, CC BY 4.0), the way
// the studio runs them: whole recordings (commands) and split at pauses (narration).
//   --fetch            download the FLEURS test sets first (Arabic and English, about 700 MB, once)
//   --lang ar|en       one language only
//   --model <id>       one model only (omnilingual-300m, parakeet-en, cohere-transcribe)
//   --limit <n>        sentences per language (default 120)
// Results: printed, and saved in .saywright/speech-eval/. Method and our numbers: docs/speech-accuracy.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, ROOT, STUDIO_DIR } from './lib/paths.mjs';
import { c } from './lib/term.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DATA = process.env.SAYWRIGHT_FLEURS || path.join(DATA_DIR, 'fleurs');
const SETS = { ar: 'ar_eg', en: 'en_us' };
const langs = value('lang') ? [value('lang')] : ['ar', 'en'];

function have(folder) {
  const dir = path.join(DATA, folder, 'audio', 'test');
  return fs.existsSync(path.join(DATA, folder, 'test.tsv')) && fs.existsSync(dir) && fs.readdirSync(dir).length > 50;
}

function fetchSet(folder) {
  // The language's whole archive streams through tar, which keeps only the test sentences.
  const gnu = /GNU/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
  const url = `https://storage.googleapis.com/xtreme_translations/FLEURS102/${folder}.tar.gz`;
  fs.mkdirSync(DATA, { recursive: true });
  console.log(c.dim(`… Downloading the ${folder} test set from FLEURS (streams the language archive, keeps the test sentences)`));
  const tar = `tar xz${gnu ? ' --wildcards' : ''} '${folder}/test.tsv' '${folder}/audio/test/*'`;
  const r = spawnSync('sh', ['-c', `curl -sSfL --retry 3 "${url}" | ${tar}`], { cwd: DATA, stdio: 'inherit' });
  if (r.status !== 0 || !have(folder)) {
    console.error(c.red(`✗ Couldn't download ${url}`));
    process.exit(1);
  }
  console.log(`${c.green('✓')} ${folder}: ${fs.readdirSync(path.join(DATA, folder, 'audio', 'test')).length} recordings`);
}

for (const lang of langs) {
  const folder = SETS[lang];
  if (!folder) {
    console.error(c.red(`✗ Unknown language ${lang} (ar or en)`));
    process.exit(1);
  }
  if (!have(folder)) {
    if (!args.includes('--fetch')) {
      console.error(c.red(`✗ No FLEURS ${folder} test set in ${DATA}.`) + ` Run ${c.cyan('npm run eval:speech -- --fetch')} to download it.`);
      process.exit(1);
    }
    fetchSet(folder);
  }
}

const env = { ...process.env, SAYWRIGHT_FLEURS: DATA, EVAL_LANG: value('lang') ?? '', EVAL_MODEL: value('model') ?? '', EVAL_LIMIT: value('limit') ?? '120' };
const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '-c', path.join(STUDIO_DIR, 'tests', 'eval', 'vitest.config.ts')], { cwd: ROOT, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
