import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
// Set PW_CHROMIUM_PATH to use an already-installed Chromium instead of Playwright's download.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
// E2E_STUDIO_PORT (and E2E_SHOP_PORT, read by serve.mjs) move the suite's servers, to run suites side by side.
const studio = `http://localhost:${process.env.E2E_STUDIO_PORT || 5273}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: studio,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    // Playwright's full Chromium, as in Chrome and Edge: its headless shell differs in the microphone, camera and screen sharing.
    channel: executablePath ? undefined : 'chromium',
    launchOptions: {
      executablePath,
      // The fake microphone plays silence; voice tests that need speech pick their own recording.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(here, 'tests/fixtures/speech/silence.wav')}`],
    },
  },
  webServer: {
    command: `node ${JSON.stringify(path.join(here, 'tests/e2e/serve.mjs'))}`,
    url: `${studio}/api/status`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: 'pipe',
  },
});
