/**
 * `saywright setup`: download the optional extras once. Everything works without them; each makes something better:
 *
 *   On-device voice model (28 MB)          voice commands understood without the browser's recogniser
 *   Speech models, Arabic and English      narration of test sessions transcribed on this computer, Arabic voice
 *   Test browser (in the repository)       running generated tests against the sample app
 */
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { browserSpeechReady, ensureBrowserSpeech } from '../server/assets.ts';
import { removePartials } from '../server/download.ts';
import { spawnProgramSync } from '../server/program.ts';
import { speechDir } from '../server/layout.ts';
import { MODELS } from '../server/speech/catalog.ts';
import { SPEECH_DOWNLOADS, SpeechService } from '../server/speech/service.ts';
import type { SpeechStatus } from '../shared/api.ts';
import type { CliContext } from './index.ts';
import { c, ok, warn } from './term.ts';

const HELP = `
${c.bold('saywright setup')} [options]: download the optional extras

  --no-speech           skip the speech models (Arabic and English, about 740 MB)
  --best-arabic         add the most accurate Arabic model without asking (1.6 GB more)
  --no-best-arabic      don't add it, don't ask
`;

/** One line that redraws itself, in a terminal; `done` clears it. */
function progress(label: string) {
  let shown = -1;
  return {
    show(fraction: number) {
      const pct = Math.round(fraction * 100);
      if (pct === shown) return;
      // Not in a terminal (a log, CI): one line as it starts, rather than nothing until it ends.
      if (!process.stdout.isTTY) {
        if (shown < 0) console.log(`… ${label}`);
        shown = pct;
        return;
      }
      shown = pct;
      process.stdout.write(`\r${c.dim(`… ${label} ${pct}%`)}`);
    },
    done() {
      if (process.stdout.isTTY && shown >= 0) process.stdout.write('\r\x1b[K');
    },
  };
}

export async function setup(argv: string[], ctx: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { speech: { type: 'boolean', default: true }, 'best-arabic': { type: 'boolean' }, hand: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    allowNegative: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const { dataDir } = ctx.layout;
  // What a stopped download left (up to 1.6 GB) goes now, and when this one is stopped.
  removePartials(speechDir(ctx.layout), SPEECH_DOWNLOADS);
  const stopped = () => {
    removePartials(speechDir(ctx.layout), SPEECH_DOWNLOADS);
    process.exit(130);
  };
  process.once('SIGINT', stopped);
  let problems = 0;
  const attempt = async (what: string, run: () => Promise<void>, otherwise: string) => {
    try {
      await run();
      ok(what);
    } catch (err) {
      problems++;
      warn(`${what}: ${err instanceof Error ? err.message : err}`, otherwise);
    }
  };
  console.log(c.bold('\nSaywright setup\n'));

  if (!browserSpeechReady(dataDir)) console.log(c.dim('… On-device voice model (28 MB)'));
  await attempt('On-device voice model', () => ensureBrowserSpeech(dataDir), 'Voice uses the browser’s recogniser alone until it is there.');
  // Hand control was removed in 0.2.0; --hand is still accepted, so scripts that pass it keep working.
  if (values.hand) console.log(c.dim('Hand control was removed in 0.2.0: there is no hand model to download.'));

  if (values.speech) {
    const speech = new SpeechService(speechDir(ctx.layout), ctx.layout.speechWorker, () => undefined);
    const status: SpeechStatus = speech.status();
    if (status.runtime === 'missing') {
      warn('The speech engine can’t run on this computer.', 'Narration is still recorded; voice uses the browser’s recogniser.');
    } else {
      const wanted = MODELS.filter((m) => m.default);
      const best = MODELS.find((m) => m.id === 'cohere-transcribe');
      const installed = (id: string) => status.models.find((m) => m.id === id)?.installed;
      if (best && !installed(best.id) && (await wantBestArabic(values['best-arabic'], best.sizeMb, best.wordErrors.ar, wanted.find((m) => m.langs.includes('ar'))?.wordErrors.ar))) wanted.push(best);
      for (const model of wanted) {
        if (installed(model.id)) {
          ok(`Speech model: ${model.label}`);
          continue;
        }
        const line = progress(`${model.label} (${model.sizeMb} MB)`);
        const tick = setInterval(() => line.show((speech.status().models.find((m) => m.id === model.id)?.installing ?? 0) / 100), 500);
        const install = () =>
          speech
            .install(model.id, (why) => {
              line.done();
              console.log(c.dim(`… ${model.label}: ${why}; continuing where it stopped`));
            })
            .finally(() => {
              clearInterval(tick);
              line.done();
            });
        await attempt(`Speech model: ${model.label}`, install, 'Install it later from Settings → Voice in the studio.');
      }
    }
  }

  // In the repository, the sample app's Playwright runs generated tests; an app of your own uses its own Playwright
  // (the Test tab installs its browser when it is missing).
  const { sample } = ctx.layout;
  if (sample.source === sample.root) {
    console.log(c.dim('… The browser Playwright uses for generated tests'));
    const r = spawnProgramSync('npx', ['playwright', 'install', 'chromium'], { cwd: sample.root, stdio: 'inherit' });
    if (r.status === 0) ok('Test browser');
    else {
      problems++;
      warn('Could not install the test browser.', 'Install it later from the Test tab in the studio.');
    }
  }

  console.log(problems ? c.yellow(`\nDone, with ${problems} thing(s) to retry later.`) : c.green('\nAll set.'));
  console.log(`Next: ${c.cyan(ctx.startCommand)}\n`);
  process.off('SIGINT', stopped);
  // A script can tell: something that failed is a failure, however much else worked.
  return problems ? 1 : 0;
}

/** The large Arabic model is much more accurate: ask (in a terminal), unless a flag already said. */
async function wantBestArabic(flag: boolean | undefined, sizeMb: number, best: number | undefined, usual: number | undefined): Promise<boolean> {
  if (flag !== undefined) return flag;
  const size = `${(sizeMb / 1000).toFixed(1)} GB`;
  const gain = `${best ?? '?'}% of words wrong instead of ${usual ?? '?'}%, measured on real speech`;
  if (!process.stdin.isTTY) {
    console.log(c.dim(`  For the most accurate Arabic (${gain}): saywright setup --best-arabic (${size}), or install it from Settings → Voice.`));
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  Will you narrate or speak in Arabic? The large Arabic model gets ${gain}. Download it (${size}, once)? [Y/n] `);
  rl.close();
  return !/^n/i.test(answer.trim());
}
