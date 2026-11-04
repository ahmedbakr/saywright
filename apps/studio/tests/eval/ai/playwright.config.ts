import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const studio = `http://localhost:${process.env.EVAL_STUDIO_PORT || 5373}`;

// The real-model benchmark (`npm run eval:ai`): opt-in, it uses your AI and costs money.
export default defineConfig({
  testDir: here,
  testMatch: 'ai.eval.spec.ts',
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: studio,
    viewport: { width: 1440, height: 900 },
    channel: executablePath ? undefined : 'chromium',
    // A fake microphone that plays silence: a session starts without asking, and nobody narrates.
    launchOptions: { executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(here, '../../fixtures/speech/silence.wav')}`] },
  },
  webServer: {
    command: `node ${JSON.stringify(path.join(here, 'serve.mjs'))}`,
    url: `${studio}/api/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
