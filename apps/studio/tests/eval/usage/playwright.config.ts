import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const studio = `http://localhost:${process.env.EVAL_STUDIO_PORT || 5473}`;

// The usage benchmark (`npm run eval:usage`): what developers do with Saywright, on projects of different kinds.
// Free unless EVAL_AI=real.
export default defineConfig({
  testDir: here,
  testMatch: 'usage.eval.spec.ts',
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: studio,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    channel: executablePath ? undefined : 'chromium',
    // A microphone that plays silence, and screen sharing allowed: a session starts without asking.
    launchOptions: {
      executablePath,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(here, '../../fixtures/speech/silence.wav')}`, '--auto-accept-this-tab-capture'],
    },
  },
  webServer: {
    command: `node ${JSON.stringify(path.join(here, 'serve.mjs'))}`,
    url: `${studio}/api/status`,
    reuseExistingServer: false,
    timeout: 10 * 60_000,
    stdout: 'pipe',
  },
});
