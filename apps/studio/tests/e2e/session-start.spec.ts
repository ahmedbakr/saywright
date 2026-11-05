/**
 * Starting a test session always works: right after stopping one, while its
 * report is being written, once it is ready, and after the studio's live
 * connection to its server dropped and came back, and when the shared screen’s
 * first picture is late.
 */
import { expect, test, type Page } from '@playwright/test';
import { openStudio, resetAll, STUDIO } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetAll();
  // What happens in the app is all these tests need.
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
});

async function record(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill(name);
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
}

/** How these sessions stand on the server. */
function statuses(...names: string[]): () => Promise<Record<string, string>> {
  return async () => {
    const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { name: string; status: string }[] };
    return Object.fromEntries(sessions.filter((s) => names.includes(s.name)).map((s) => [s.name, s.status]));
  };
}

/** Keep a handle on the studio's event streams, to cut them. */
async function cuttable(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const streams: EventSource[] = [];
    Object.assign(window, { __streams: streams });
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        streams.push(this);
      }
    };
  });
}

/** The studio's live connection to its server drops, and stays down. */
async function cut(page: Page): Promise<void> {
  await page.route('**/api/events', (route) => route.abort());
  await page.evaluate(() => (window as unknown as { __streams: EventSource[] }).__streams.forEach((es) => es.dispatchEvent(new Event('error'))));
}

test('a new session starts right after the last one, without waiting for or opening its report', async ({ page }) => {
  await openStudio(page);
  await record(page, 'First');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  // Straight away, while the report is being written (or just after); it's announced when it's ready either way.
  await record(page, 'Second');
  await expect(page.getByText('Report ready: First')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  // Its report is ready: the next session still starts from the bar.
  await expect(page.getByRole('button', { name: 'Report ready' })).toBeVisible({ timeout: 60_000 });
  await record(page, 'Third');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(statuses('First', 'Second', 'Third'), { timeout: 60_000 }).toEqual({ First: 'ready', Second: 'ready', Third: 'ready' });
  await page.getByRole('button', { name: 'Report ready' }).click();
  await expect(page).toHaveURL(/\/report\//);
  // Opened: the bar is back to just starting a session.
  await expect(page.getByRole('button', { name: 'Report ready' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record session', exact: true })).toBeVisible();
});

test('a report already written when the next session starts is announced once that one records', async ({ page }) => {
  await openStudio(page);
  await record(page, 'Quick');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report ready' })).toBeVisible({ timeout: 60_000 });
  // Not opened: starting the next session takes its place in the bar, so it is announced instead.
  await record(page, 'Next');
  await expect(page.getByText('Report ready: Quick')).toBeVisible({ timeout: 15_000 });
  // The new recording goes on.
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
});

test('a report that finishes while the next session records is announced, even when its live update is missed', async ({ page }) => {
  await cuttable(page);
  await openStudio(page);
  await record(page, 'Earlier');
  // Down from before the report is written to the end: only asking the server can tell the studio it's ready.
  await cut(page);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await record(page, 'Later');
  await expect.poll(statuses('Earlier'), { timeout: 60_000 }).toEqual({ Earlier: 'ready' });
  await expect(page.getByText('Report ready: Earlier')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
});

test('a report finished while the live connection was down is still announced, and the next session starts', async ({ page }) => {
  await cuttable(page);
  await openStudio(page);
  await record(page, 'Dropped');
  // The connection drops, and stays down until the report has been written.
  await cut(page);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(statuses('Dropped'), { timeout: 60_000 }).toEqual({ Dropped: 'ready' });
  await page.unroute('**/api/events');
  await expect(page.getByRole('button', { name: 'Report ready' })).toBeVisible({ timeout: 15_000 });
  await record(page, 'After');
});

test('a start stuck on sharing the screen can be cancelled, and gives up with what to do', async ({ page }) => {
  // The browser's question about sharing the screen never comes back.
  await page.addInitScript(() => {
    localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: true, video: false, countdown: 0 }));
    navigator.mediaDevices.getDisplayMedia = () => new Promise(() => undefined);
  });
  await page.clock.install();
  await openStudio(page);
  const count = async () => ((await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: unknown[] }).sessions.length;
  const before = await count();
  const start = async () => {
    await page.getByRole('button', { name: 'Record session', exact: true }).click();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText('Starting…').first()).toBeVisible();
  };
  await start();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.getByRole('button', { name: 'Record session', exact: true })).toBeVisible();
  expect(await count()).toBe(before);

  // Left waiting, it gives up and says what to do.
  await start();
  await page.clock.fastForward('00:31');
  await expect(page.getByText(/Sharing the screen didn’t start within 30 seconds\. Start again, or turn off “Record the screen”\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
});

test('a shared screen whose first picture is late doesn’t hold the start up, and the start’s picture comes with it', async ({ page }) => {
  // A share that sends no frame until its picture changes, as a still page cropped to the app can: a canvas that draws
  // only when told.
  await page.addInitScript(() => {
    localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: true, video: false, countdown: 0 }));
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 400;
    const stream = canvas.captureStream(0);
    const firstFrame = () => {
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#3a7';
      g.fillRect(0, 0, 640, 400);
      (stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
    };
    Object.assign(window, { __firstFrame: firstFrame });
    navigator.mediaDevices.getDisplayMedia = async () => stream;
  });
  await openStudio(page);
  await record(page, 'Late picture');
  const shot = page.waitForRequest((r) => /\/shots\?.*reason=start/.test(r.url()));
  await page.evaluate(() => (window as unknown as { __firstFrame: () => void }).__firstFrame());
  await shot;
});

test('once a session records, the app stays where it is: a click as it begins lands on what it was aimed at', async ({ page }) => {
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('coupon-apply')).toBeVisible();
  await record(page, 'Steady start');
  // Where the app is on the studio's page, every frame for the first moments of the recording.
  const tops = await page.evaluate(
    () =>
      new Promise<number[]>((done) => {
        const frame = document.querySelector('iframe')!;
        const out: number[] = [];
        const t0 = performance.now();
        const tick = () => {
          out.push(Math.round(frame.getBoundingClientRect().top * 10) / 10);
          if (performance.now() - t0 < 700) requestAnimationFrame(tick);
          else done(out);
        };
        tick();
      }),
  );
  expect(tops.length).toBeGreaterThan(5);
  expect([...new Set(tops)]).toEqual([tops[0]]);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});
