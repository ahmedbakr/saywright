/**
 * Linked apps: the app list, linking a folder of HTML (served and shown
 * through the studio's proxy, which adds the bridge), a project with a dev
 * command (started by the studio, found wherever it listens), switching apps
 * (a change waiting for keep or undo is settled first), and each app keeping
 * its own sessions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { appPoint, openStudio, resetAll, shopFile, store, STUDIO } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '../fixtures/apps');

interface AppsState {
  apps: { id: string; name: string; root: string | null; envs: { url: string; connection: string }[] }[];
  active: string | null;
  runs: { app: string; status: string; url: string | null }[];
}

const call = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${STUDIO}/api${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
};

function copyFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `saywright-${name}-`));
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

async function shopId(): Promise<string> {
  const { apps } = await call<AppsState>('GET', '/apps');
  return apps.find((a) => a.root?.endsWith('.e2e-shop'))!.id;
}

/** Link a folder through the API (the UI flow has its own test). */
async function linkFolder(folder: string): Promise<string> {
  const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { folder });
  const { app } = await call<{ app: { id: string } }>('POST', '/apps', { probe, open: false });
  return app.id;
}

const frame = (page: Page) => page.frameLocator('iframe');

/**
 * Click in the app the way a person can: once nothing of the studio's covers that point. (Playwright looks inside the
 * frame only, so it would click a layer of the studio's lying over the app.) Says what covers it if that lasts.
 */
async function clickInApp(page: Page, testId: string): Promise<void> {
  const target = frame(page).getByTestId(testId);
  const box = (await target.boundingBox())!;
  const at: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
  const cover = () =>
    page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el?.tagName === 'IFRAME' ? 'the app' : el ? `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 120)}">` : 'nothing';
    }, at);
  await expect.poll(cover, { message: `what is over the app's ${testId}` }).toBe('the app');
  await target.click();
}

/** What the studio shows, for a failure's message: its mode, whether the app is connected, and where the frame is. */
async function studioState(page: Page): Promise<string> {
  const s = await page.evaluate(() => {
    const st = (window as any).__saywrightStore.get();
    return { mode: st.mode, connected: st.app.connected, app: st.app.url, frames: document.querySelectorAll('iframe').length };
  });
  return JSON.stringify({ ...s, frameUrls: page.frames().map((f) => f.url()) });
}

test.beforeEach(() => resetAll());
test.afterEach(async () => {
  // The other tests work on the sample shop.
  await call('POST', `/apps/${await shopId()}/open`, { decide: 'undo' }).catch(() => undefined);
  for (const a of (await call<AppsState>('GET', '/apps')).apps) if (!a.root?.endsWith('.e2e-shop')) await call('DELETE', `/apps/${a.id}`).catch(() => undefined);
});

test('link a folder of HTML from the app list: served, shown through the proxy, and pointing works', async ({ page }) => {
  const folder = copyFixture('plain');
  await openStudio(page);
  // The app list, from the app menu.
  await page.locator('[data-app-switcher]').click();
  await page.getByRole('menuitem', { name: 'All apps' }).click();
  await expect(page.locator('[data-launcher]')).toBeVisible();
  await expect(page.locator('[data-app]')).toHaveCount(1);
  await page.locator('[data-link-app]').click();
  // Pick the folder.
  await page.getByRole('textbox', { name: 'Folder' }).fill(folder);
  await page.getByRole('button', { name: 'Go' }).click();
  await page.locator('[data-use-folder]').click();
  await expect(page.locator('[data-probe]')).toContainText('Static site');
  await expect(page.locator('[data-probe]')).toContainText('serves this folder as a static site');
  await page.locator('[data-link-confirm]').click();
  // Open: the studio serves it, and shows it through its proxy.
  await expect(page.locator('[data-launcher]')).toHaveCount(0, { timeout: 20_000 });
  await expect(frame(page).getByRole('heading', { name: 'Your notes' })).toBeVisible();
  const frameUrl = await store<string>(page, 's.status.target.frameUrl');
  expect(frameUrl).toMatch(/^http:\/\/localhost:\d+\/$/);
  await expect(page.locator('[data-app-switcher]')).toContainText('Lantern Notes');
  // The page's CSP didn't keep the bridge out: pointing selects what is under the mouse.
  await page.waitForFunction(() => (window as any).__saywrightStore.get().app.connected);
  const add = await appPoint(page, 'add-note');
  await page.mouse.move(add.x, add.y);
  await page.mouse.click(add.x, add.y);
  await expect.poll(() => store<string | null>(page, 's.selection?.label ?? null')).toContain('Add a note');
  expect(await frame(page).locator('meta[http-equiv]').count()).toBe(0);
  // Asking for a change: the studio finds the button in index.html (the page doesn't say where it was written), and the page loads again with it.
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make it say “Write a note”');
  await page.keyboard.press('Enter');
  await expect.poll(() => fs.readFileSync(path.join(folder, 'index.html'), 'utf8')).toContain('>Write a note</button>');
  await expect(frame(page).getByTestId('add-note')).toHaveText('Write a note');
  await page.getByRole('button', { name: /Undo/ }).first().click();
  await expect.poll(() => fs.readFileSync(path.join(folder, 'index.html'), 'utf8')).toContain('>Add a note</button>');
  await expect(frame(page).getByTestId('add-note')).toHaveText('Add a note');
  // Links stay inside the proxy.
  await page.getByRole('radio', { name: 'Use' }).click();
  await frame(page).getByRole('link', { name: 'About' }).click();
  await expect(frame(page).getByRole('heading', { name: 'About Lantern Notes' })).toBeVisible();
  await expect.poll(() => store<string>(page, 's.app.url')).toMatch(/^http:\/\/localhost:\d+\/about\.html$/);
});

test('a folder that isn’t an app says so, offers the apps inside it, and can’t be linked as it is', async ({ page }) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-projects-'));
  fs.mkdirSync(path.join(parent, 'docs'));
  fs.cpSync(path.join(FIXTURES, 'plain'), path.join(parent, 'notes-app'), { recursive: true });
  await openStudio(page);
  // “Link an app…” in the app menu opens the Link dialog itself, with a visible title and a way out.
  await page.locator('[data-app-switcher]').click();
  await page.getByRole('menuitem', { name: 'Link an app…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Link an app' });
  await expect(dialog.getByRole('heading', { name: 'Link an app' })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Folder' }).fill(parent);
  await dialog.getByRole('button', { name: 'Go' }).click();
  // App folders come first, each with its own Use button.
  await expect(dialog.locator('[data-folder]:not([data-folder=".."])').first()).toHaveAttribute('data-folder', 'notes-app');
  await expect(dialog.getByRole('button', { name: 'Use notes-app' })).toBeVisible();
  // The folder typed is the one used, not the one listed.
  await dialog.getByRole('textbox', { name: 'Folder' }).fill(path.join(parent, 'docs'));
  await dialog.locator('[data-use-folder]').click();
  await expect(dialog.locator('[data-probe]')).toContainText(path.join(parent, 'docs'));
  await dialog.getByRole('button', { name: 'Back' }).click();
  // The folder above it is not an app: it says so before linking, and suggests the one inside.
  await dialog.getByRole('textbox', { name: 'Folder' }).fill(parent);
  await dialog.getByRole('button', { name: 'Go' }).click();
  await expect(dialog.getByRole('button', { name: 'Use notes-app' })).toBeVisible();
  await dialog.locator('[data-use-folder]').click();
  await expect(dialog.locator('[data-not-an-app]')).toContainText('No package.json, index.html or index.php here');
  await expect(dialog.locator('[data-link-confirm]')).toBeDisabled();
  const parentName = await dialog.getByRole('textbox', { name: 'Name' }).inputValue();
  await dialog.locator('[data-suggested-apps]').getByRole('button', { name: /notes-app/ }).click();
  await expect(dialog.locator('[data-probe]')).toContainText('Static site');
  // The app picked has its own name and address, not the folder's above it.
  await expect(dialog.getByRole('textbox', { name: 'Name' })).not.toHaveValue(parentName);
  await expect(dialog.locator('[data-probe]')).toContainText(path.join(parent, 'notes-app'));
  await expect(dialog.locator('[data-not-an-app]')).toHaveCount(0);
  await expect(dialog.locator('[data-link-confirm]')).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await call<AppsState>('GET', '/apps')).apps.some((a) => a.root?.startsWith(parent))).toBe(false);
});

test('a project with a dev command: the studio starts it, finds where it listens, and says why when it can’t', async ({ page }) => {
  const folder = copyFixture('devserver');
  fs.mkdirSync(path.join(folder, 'node_modules'));
  const id = await linkFolder(folder);
  await openStudio(page);
  await page.locator('[data-app-switcher]').click();
  await page.getByRole('menuitem', { name: 'All apps' }).click();
  const card = page.locator(`[data-app="${id}"]`);
  await expect(card).toContainText('harbor-dashboard');
  await card.locator('[data-open-app]').click();
  // It refuses to be framed (X-Frame-Options: DENY) and moved off its usual port: neither matters.
  await expect(frame(page).getByRole('heading', { name: 'Harbor Dashboard' })).toBeVisible({ timeout: 30_000 });
  const state = await call<AppsState>('GET', '/apps');
  const run = state.runs.find((r) => r.app === id)!;
  expect(run.status).toBe('running');
  expect(run.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  expect(state.apps.find((a) => a.id === id)!.envs[0].url).toBe(new URL(run.url!).origin);

  // A dev command that fails: its output says why.
  await call('POST', `/apps/${id}/stop`);
  await call('POST', `/apps/${await shopId()}/open`);
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'harbor-dashboard', scripts: { dev: 'node -e "console.error(\'Error: DATABASE_URL is not set\'); process.exit(1)"' } }));
  await call('PUT', `/apps/${id}`, { start: 'npm run dev' });
  await page.locator('[data-app-switcher]').click();
  await page.getByRole('menuitem', { name: 'All apps' }).click();
  await card.locator('[data-open-app]').click();
  await expect(page.locator('[data-opening="failed"]')).toContainText('didn’t open', { timeout: 30_000 });
  await expect(page.locator('[data-run-log]')).toContainText('DATABASE_URL is not set');
});

test('Cancel while an app is starting stops it, and what was cancelled isn’t then reported as a failure', async ({ page }) => {
  const folder = copyFixture('devserver');
  fs.mkdirSync(path.join(folder, 'node_modules'));
  // A dev command that never answers: there is time to think again.
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'harbor-dashboard', scripts: { dev: 'node -e "setTimeout(() => {}, 120000)"' } }));
  const id = await linkFolder(folder);
  await openStudio(page);
  await page.locator('[data-app-switcher]').click();
  await page.getByRole('menuitem', { name: 'All apps' }).click();
  const answer = page.waitForResponse((r) => r.url().endsWith(`/api/apps/${id}/open`));
  await page.locator(`[data-app="${id}"] [data-open-app]`).click();
  const opening = page.locator('[data-opening]');
  await expect(opening).toContainText('Starting harbor-dashboard');
  await opening.getByRole('button', { name: 'Cancel' }).click();
  await expect(opening).toHaveCount(0);
  // The request to open it ends once it has stopped, with why it didn't start: nothing the person needs telling.
  const res = await answer;
  expect(res.status()).toBe(502);
  await res.finished();
  await page.waitForTimeout(400);
  await expect(opening).toHaveCount(0);
  expect((await call<AppsState>('GET', '/apps')).runs.find((r) => r.app === id)?.status).toBe('stopped');
});

test('a dev server that stops on its own is said so over the app, and Start it again brings it back', async ({ page }) => {
  const folder = copyFixture('devserver');
  fs.mkdirSync(path.join(folder, 'node_modules'));
  const id = await linkFolder(folder);
  await openStudio(page);
  await call('POST', `/apps/${id}/open`);
  await page.reload();
  await expect(frame(page).getByRole('heading', { name: 'Harbor Dashboard' })).toBeVisible({ timeout: 30_000 });
  const run = (await call<AppsState>('GET', '/apps')).runs.find((r) => r.app === id)!;
  await fetch(new URL('/__exit', run.url!)).catch(() => undefined);
  // The page it showed stays, but nothing answers behind it: said at once, with a way back.
  const cover = page.locator('[data-crashed]');
  await expect(cover).toContainText('harbor-dashboard’s dev server stopped', { timeout: 10_000 });
  await expect(cover).toContainText(/\(exit code \d+\)/);
  await cover.getByRole('button', { name: 'Start it again' }).click();
  await expect(cover).toBeHidden({ timeout: 30_000 });
  await expect.poll(async () => (await call<AppsState>('GET', '/apps')).runs.find((r) => r.app === id)?.status, { timeout: 30_000 }).toBe('running');
  await expect(frame(page).getByRole('heading', { name: 'Harbor Dashboard' })).toBeVisible({ timeout: 30_000 });
});

test('switching apps settles a change waiting for keep or undo first', async ({ page }) => {
  const plain = await linkFolder(copyFixture('plain'));
  await openStudio(page);
  // A preview in the shop.
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make it bigger');
  await page.keyboard.press('Enter');
  await expect.poll(() => shopFile('src/components/CouponField.tsx')).not.toContain('<Button variant="secondary" size="sm" type="submit"');
  // Switch to the other app from the menu.
  await page.locator('[data-app-switcher]').click();
  await page.getByRole('menuitem', { name: 'Lantern Notes' }).click();
  await expect(page.locator('[data-pending-switch]')).toContainText('has a change waiting for keep or undo');
  await page.getByRole('button', { name: 'Undo and switch' }).click();
  await expect(frame(page).getByRole('heading', { name: 'Your notes' })).toBeVisible({ timeout: 20_000 });
  expect(shopFile('src/components/CouponField.tsx')).toContain('<Button variant="secondary" size="sm" type="submit" data-testid="coupon-apply">');
  expect((await call<AppsState>('GET', '/apps')).active).toBe(plain);
});

test('each app keeps its own sessions, recorded through the proxy too', async ({ page }) => {
  const plain = await linkFolder(copyFixture('plain'));
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
  await call('POST', `/apps/${plain}/open`);
  await openStudio(page);
  await expect(frame(page).getByRole('heading', { name: 'Your notes' })).toBeVisible();
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Notes through the proxy');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await clickInApp(page, 'add-note');
  await expect(frame(page).getByText('A new note'))
    .toBeVisible()
    .catch(async (e: Error) => {
      throw new Error(`${e.message}\nThe studio then: ${await studioState(page)}`);
    });
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  let id = '';
  await expect
    .poll(async () => {
      const { sessions } = await call<{ sessions: { id: string; name: string; status: string }[] }>('GET', '/sessions');
      const s = sessions.find((x) => x.name === 'Notes through the proxy');
      id = s?.id ?? '';
      return s?.status;
    }, { timeout: 60_000 })
    .toBe('ready');
  const detail = await call<{ analysis: { steps: { kind: string; description: string }[]; pages: { url: string }[] } }>('GET', `/sessions/${id}`);
  expect(detail.analysis.steps.map((s) => s.description)).toContainEqual(expect.stringContaining('Add a note'));
  // The shop doesn't list it.
  await call('POST', `/apps/${await shopId()}/open`);
  const { sessions } = await call<{ sessions: { name: string }[] }>('GET', '/sessions');
  expect(sessions.map((s) => s.name)).not.toContain('Notes through the proxy');
});

test('an app can be removed from the studio; its files stay', async ({ page }) => {
  const folder = copyFixture('plain');
  const id = await linkFolder(folder);
  await openStudio(page);
  await page.locator('[data-app-switcher]').click();
  await page.getByRole('menuitem', { name: 'All apps' }).click();
  await page.locator(`[data-app="${id}"]`).getByRole('button', { name: 'More for Lantern Notes' }).click();
  await page.getByRole('menuitem', { name: 'Remove from the studio' }).click();
  // The studio's own question (not the browser's), with Cancel first.
  const ask = page.getByRole('alertdialog', { name: 'Remove Lantern Notes from the studio?' });
  await expect(ask).toContainText('stay where they are');
  await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await ask.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator(`[data-app="${id}"]`)).toHaveCount(0);
  expect(fs.existsSync(path.join(folder, 'index.html'))).toBe(true);
});
