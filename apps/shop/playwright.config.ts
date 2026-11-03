import { defineConfig, devices } from '@playwright/test';

// The studio sets SAYWRIGHT_TARGET_URL when it runs tests against the live dev server.
const target = process.env.SAYWRIGHT_TARGET_URL;
const baseURL = target ?? 'http://localhost:5174';
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests',
  timeout: 20_000,
  reporter: [['list']],
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: target
    ? undefined
    : { command: 'npm run dev', url: baseURL, reuseExistingServer: true },
});
