import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { appPoint, E2E_SHOP, expectIsland, forgetTour, keyNames, literally, openStudio, resetAll, SHOP_URL, shopFile, store, STUDIO } from './helpers';

test.beforeEach(() => resetAll());

test('first run shows the quick-start tour, not the setup; there is no hand control, and the voice check goes straight to talking', async ({ page }) => {
  await forgetTour();
  await openStudio(page, { theme: 'dark' });
  const tour = page.locator('[data-tour-card]');
  await expect(tour).toContainText('Point at something', { timeout: 15_000 });
  await expect(page.getByRole('dialog', { name: 'Set up Saywright' })).toHaveCount(0);
  // Hand control (the camera) is gone: no Hand chip, and C does nothing.
  await expect(page.getByRole('button', { name: /^Hand/ })).toHaveCount(0);
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'Set up Saywright' })).toHaveCount(0);
  await tour.getByRole('button', { name: 'Skip tour' }).click();
  // Settings has no Labs or Hand page any more.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Labs' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hand', exact: true })).toHaveCount(0);
  // The voice check, from Settings: straight to talking.
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Set up Saywright' });
  await expect(setup.getByText('Talk to it')).toBeVisible();
  await expect(setup).not.toContainText('Point at your app. Say what to change.');
  await setup.getByRole('button', { name: 'Finish' }).click();
  await expectIsland(page, /You’re set/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('saywright.settings')!).state.onboarded)).toBe(true);
});

test('settings saved by a studio that had hand control load without them', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem(
      'saywright.settings',
      JSON.stringify({ version: 2, state: { theme: 'dark', onboarded: true, camera: { enabled: true, deviceId: 'x' }, engine: { hand: 'right' }, aimAssist: 30, dwellSelect: true, labs: { hand: true }, voice: { lang: 'en-US', autoStopMs: 1500 } } }),
    );
  });
  await page.goto(STUDIO);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('saywright.settings') ?? '{}').version)).toBe(3);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('saywright.settings')!).state);
  expect(saved.theme).toBe('dark');
  expect(saved.voice.autoStopMs).toBe(1500);
  for (const gone of ['camera', 'engine', 'aimAssist', 'dwellSelect', 'labs']) expect(saved).not.toHaveProperty(gone);
});

test('saved settings apply from the first paint, and the script tag apps add loads the bridge', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.clear();
    localStorage.setItem('saywright.settings', JSON.stringify({ state: { onboarded: true, theme: 'light' }, version: 1 }));
  });
  await page.goto('/');
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.getByText('Point at your app. Say what to change.')).toHaveCount(0);
  const script = await (await fetch(`${STUDIO}/saywright.js`)).text();
  expect(script.startsWith('window.__SAYWRIGHT__=')).toBe(true);
});

test('hover, select and inspect a component with the mouse', async ({ page }) => {
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.move(apply.x, apply.y);
  await expect.poll(() => store<string>(page, 's.hover?.label')).toContain('Apply');
  await page.mouse.click(apply.x, apply.y);
  await expect.poll(() => store<string>(page, 's.selection?.name')).toBe('Button');
  await page.getByRole('tab', { name: /Inspect/ }).click();
  await expect(page.getByText('src/components/CouponField.tsx:45')).toBeVisible();
  await expect(page.getByText('Design system')).toBeVisible();
  await expect(page.getByRole('button', { name: 'secondary' })).toBeVisible();
});

test('O opens the selected element’s line in your editor, or says why it couldn’t', async ({ page }) => {
  // The studio's answers, as it gives them (the real one would start the editor running on this computer).
  const asked: string[] = [];
  let answer = { status: 409, body: { error: 'Couldn’t find your code editor. Open it, or set LAUNCH_EDITOR to its command (such as code), and try again.', code: 'no-editor' } as object };
  await page.route('**/__open-in-editor?*', (route: Route) => {
    asked.push(`${route.request().method()} ${decodeURIComponent(new URL(route.request().url()).searchParams.get('file') ?? '')}`);
    return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
  });
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await expect.poll(() => store<string>(page, 's.selection?.name')).toBe('Button');
  await page.keyboard.press('o');
  await expectIsland(page, /Couldn’t find your code editor/);
  expect(await page.locator('[data-island]').innerText()).not.toMatch(/Opening/);
  expect(asked[0]).toMatch(/^POST .*\/src\/components\/CouponField\.tsx:45:\d+$/);
  answer = { status: 200, body: { ok: true, editor: 'code' } };
  await page.keyboard.press('o');
  await expectIsland(page, /Opening components\/CouponField\.tsx:45 in your editor…/);
});

test('an idle studio draws nothing: it wakes for the pointer on the app, and sleeps again once it leaves', async ({ page }) => {
  await openStudio(page);
  /** Animation frames the studio's page asks for in `ms`. */
  const frames = (ms: number) =>
    page.evaluate((ms) => new Promise<number>((done) => {
      let n = 0;
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) => raf((t) => (n++, cb(t)));
      setTimeout(() => {
        window.requestAnimationFrame = raf;
        done(n);
      }, ms);
    }), ms);
  const canvas = () => page.locator('canvas.fixed').evaluate((c) => getComputedStyle(c).visibility);
  await page.waitForTimeout(1000);
  expect(await frames(1500)).toBe(0);
  expect(await canvas()).toBe('hidden');

  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.move(apply.x, apply.y, { steps: 4 });
  await expect.poll(() => store<string>(page, 's.hover?.label')).toContain('Apply');
  await page.mouse.move(5, 5);
  await expect.poll(() => store<string | null>(page, 's.hover')).toBeNull();
  await page.waitForTimeout(500);
  expect(await frames(1000)).toBe(0);
});

test('a typed quick edit previews instantly, then Enter keeps it and the code changes', async ({ page }) => {
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make it bigger');
  await page.keyboard.press('Enter');
  await expectIsland(page, /Apply.*size sm → md.*Quick edit/);
  expect(shopFile('src/components/CouponField.tsx')).toContain('<Button variant="secondary" type="submit" data-testid="coupon-apply">');
  // The app hot-reloads with the bigger button.
  await expect.poll(async () => (await page.frameLocator('iframe').getByTestId('coupon-apply').boundingBox())?.height ?? 0).toBeGreaterThan(40);
  await page.mouse.click(8, 400);
  await page.keyboard.press('Enter');
  await expectIsland(page, /Kept/);
  expect(await store<string>(page, 's.changes[0].status')).toBe('kept');
});

test('undo restores the exact previous code', async ({ page }) => {
  await openStudio(page);
  const before = shopFile('src/components/CouponField.tsx');
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('rename to Use code');
  await page.keyboard.press('Enter');
  await expectIsland(page, /Rename/);
  await expect(page.frameLocator('iframe').getByTestId('coupon-apply')).toHaveText('Use code');
  await page.getByRole('button', { name: /Undo/ }).first().click();
  await expectIsland(page, /Undone/);
  expect(shopFile('src/components/CouponField.tsx')).toBe(before);
});

/**
 * A change of two files where the first alone breaks the checkout: it reads a cart that the second starts passing
 * (as an AI's change to share the cart between pages does). Only the first item is passed, so the total shows it landed.
 */
const SHARED_CART: Record<string, [string, string][]> = {
  'src/pages/Checkout.tsx': [
    ["import { CART, SHIPPING_FLAT } from '../lib/cart';", "import { SHIPPING_FLAT, type CartItem } from '../lib/cart';"],
    ['export function Checkout({ onToast }: { onToast: (text: string) => void }) {', 'export function Checkout({ onToast, cart }: { onToast: (text: string) => void; cart: CartItem[] }) {'],
    ['calcTotals(CART, SHIPPING_FLAT, coupon), [coupon]', 'calcTotals(cart, SHIPPING_FLAT, coupon), [cart, coupon]'],
    ['<LineItems items={CART} />', '<LineItems items={cart} />'],
  ],
  'src/App.tsx': [
    ["import { Checkout } from './pages/Checkout';", "import { CART } from './lib/cart';\nimport { Checkout } from './pages/Checkout';"],
    ['<Checkout onToast={setToast} />', '<Checkout onToast={setToast} cart={CART.slice(0, 1)} />'],
  ],
};

/** The app's page, collecting the errors it throws from its first moment (it keeps them across hot updates). */
async function catchAppErrors(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __errors: string[] };
    w.__errors = [];
    addEventListener('error', (e) => w.__errors.push(e.message));
  });
  return () => page.frames().find((f) => f.url().startsWith(SHOP_URL))!.evaluate(() => (window as unknown as { __errors: string[] }).__errors);
}

test('a change of several files reaches the running app at once, however long it takes to write', async ({ page }) => {
  const errors = await catchAppErrors(page);
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('summary-total')).toContainText('$98.00');
  // What the studio's server does before writing such a change: the app's dev server holds the page's updates.
  const files = Object.keys(SHARED_CART).map((f) => path.join(E2E_SHOP, f));
  expect(await (await fetch(`${SHOP_URL}/__saywright/hold`, { method: 'POST', body: JSON.stringify({ files }) })).json()).toEqual({ ok: true, held: true });
  const write = (rel: string) => fs.writeFileSync(path.join(E2E_SHOP, rel), SHARED_CART[rel].reduce((code, [from, to]) => code.replace(from, to), shopFile(rel)));
  write('src/pages/Checkout.tsx');
  await page.waitForTimeout(1500);
  // Half written, the checkout would throw (“Cannot read properties of undefined”): the page hasn't run it.
  expect(await errors()).toEqual([]);
  await expect(app.getByTestId('summary-total')).toContainText('$98.00');
  write('src/App.tsx');
  await expect(app.getByTestId('summary-total')).toContainText('$66.00');
  expect(await errors()).toEqual([]);
});

test('a change of several files from an AI app shows in the running app whole, and is undone whole', async ({ page }) => {
  const errors = await catchAppErrors(page);
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('summary-total')).toContainText('$98.00');
  const { mcp } = (await (await fetch(`${STUDIO}/api/ai`)).json()) as { mcp: { token: string } };
  const edits = Object.entries(SHARED_CART).flatMap(([file, pairs]) => pairs.map(([old_string, new_string]) => ({ path: file, old_string, new_string })));
  const res = await fetch(`${STUDIO}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_change', arguments: { title: 'Share the cart', summary: 'Checkout reads the cart from App.', edits } } }),
  });
  expect(((await res.json()) as { result: { isError: boolean } }).result.isError).toBe(false);
  await expect(app.getByTestId('summary-total')).toContainText('$66.00');
  await page.getByRole('button', { name: /Undo/ }).first().click();
  await expect(app.getByTestId('summary-total')).toContainText('$98.00');
  await page.waitForTimeout(500);
  expect(await errors()).toEqual([]);
});

test('the Changes tab keeps and undoes like the rest of the studio: a file edited since asks before undoing anyway', async ({ page }) => {
  await openStudio(page, { onboarded: true, theme: 'dark', ui: { panelOpen: true, panelTab: 'changes', device: 'fill', commitOnKeep: false } });
  const file = 'src/components/CouponField.tsx';
  const before = shopFile(file);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('rename to Use code');
  await page.keyboard.press('Enter');
  await expectIsland(page, /Rename/);
  // Edited by hand meanwhile: undoing here would lose that, so the studio asks.
  fs.writeFileSync(path.join(E2E_SHOP, file), `${shopFile(file)}\n// edited by hand\n`);
  await page.locator('[data-change]').first().getByRole('button', { name: 'Undo' }).click();
  await expectIsland(page, /was edited after this change/);
  await page.locator('[data-island]').getByRole('button', { name: 'Undo anyway' }).click();
  await expectIsland(page, /Undone/);
  expect(shopFile(file)).toBe(before);

  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make it bigger');
  await page.keyboard.press('Enter');
  await expectIsland(page, /size sm → md/);
  await page.locator('[data-change]').first().getByRole('button', { name: 'Keep' }).click();
  await expectIsland(page, /Kept/);
  expect(await store<string>(page, 's.changes[0].status')).toBe('kept');
});

test('undoing an older preview in the Changes tab says which newer ones go with it, and asks first', async ({ page }) => {
  await openStudio(page, { onboarded: true, theme: 'dark', ui: { panelOpen: true, panelTab: 'changes', device: 'fill', commitOnKeep: false } });
  const before = shopFile('src/components/CouponField.tsx');
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  const bar = page.getByRole('textbox', { name: 'Describe a change' });
  await bar.fill('rename to Use code');
  await bar.press('Enter');
  await expectIsland(page, /Rename/);
  await bar.fill('make it bigger');
  await bar.press('Enter');
  await expectIsland(page, /size sm → md/);
  // The newest is on top: the older one (open since it was made) says what its Undo also undoes.
  const older = page.locator('[data-change]').nth(1);
  await expect(older).toContainText('Rename');
  if (!(await older.getByRole('button', { name: 'Undo (and 1 newer)' }).isVisible())) await older.getByRole('button', { name: /Rename/ }).click();
  await older.getByRole('button', { name: 'Undo (and 1 newer)' }).click();
  await expect(older.locator('[data-undo-newer]')).toContainText('size sm → md');
  await older.getByRole('button', { name: 'Cancel' }).click();
  expect(await store<number>(page, "s.changes.filter((c) => c.status === 'preview').length")).toBe(2);
  await older.getByRole('button', { name: 'Undo (and 1 newer)' }).click();
  await older.getByRole('button', { name: 'Undo all 2' }).click();
  await expectIsland(page, /Undid 2 changes/);
  expect(shopFile('src/components/CouponField.tsx')).toBe(before);
});

test('Escape in the empty command bar right after sending stops the request, rather than only leaving the bar', async ({ page }) => {
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  const bar = page.getByRole('textbox', { name: 'Describe a change' });
  // The request (to the AI stand-in) is held on its way, as a slow model would be: it never gets there.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/intent', async (route) => {
    await held;
    await route.abort().catch(() => undefined);
  });
  await bar.fill('fix the coupon discount');
  await bar.press('Enter');
  await expect.poll(() => store<boolean>(page, '!!s.request')).toBe(true);
  const id = await store<string>(page, 's.request.id');
  await expect(bar).toBeFocused();
  const cancel = page.waitForRequest((r) => r.url().endsWith('/api/cancel') && r.method() === 'POST');
  await bar.press('Escape');
  // The studio's server is told to stop it, and the island says it is stopping.
  expect(JSON.parse((await cancel).postData() ?? '{}')).toMatchObject({ requestId: id });
  await expect.poll(() => store<string>(page, "s.request ? s.request.step : 'none'")).toMatch(/^(Stopping|none)$/);
  release();
  await expect.poll(() => store<boolean>(page, '!!s.request'), { timeout: 8000 }).toBe(false);
  expect(await store<number>(page, "s.changes.filter((c) => c.status === 'preview').length")).toBe(0);
});

test('a preview made in another studio tab shows here at once, and is undone from here', async ({ page, context }) => {
  await openStudio(page);
  const other = await context.newPage();
  await other.goto('/');
  await other.waitForFunction(() => (window as any).__saywrightStore?.get().app.connected, null, { timeout: 30_000 });
  const before = shopFile('src/components/CouponField.tsx');
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('rename to Use code');
  await page.keyboard.press('Enter');
  await expectIsland(page, /Rename/);
  await expect.poll(() => store<number>(other, "s.changes.filter((c) => c.status === 'preview').length"), { timeout: 3000 }).toBe(1);
  await other.bringToFront();
  await other.locator('body').click({ position: { x: 4, y: 300 } });
  await other.keyboard.press('Control+z');
  await expectIsland(other, /Undone/);
  expect(shopFile('src/components/CouponField.tsx')).toBe(before);
  // …and the first tab is told it was undone.
  await expect.poll(() => store<number>(page, "s.changes.filter((c) => c.status === 'preview').length"), { timeout: 3000 }).toBe(0);
  await other.close();
});

test('Reload the app stays on the page the app is on', async ({ page }) => {
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await app.locator('body').evaluate(() => (location.hash = '#/account'));
  await expect(app.getByRole('heading', { name: 'Your account' })).toBeVisible();
  // When the app's page was loaded: a reload makes a new one.
  const loaded = () => app.locator('body').evaluate(() => performance.timeOrigin, null, { timeout: 2000 }).catch(() => 0);
  const first = await loaded();
  await page.getByRole('button', { name: 'Reload the app' }).click();
  await expect.poll(loaded, { timeout: 15_000 }).toBeGreaterThan(first);
  await expect(app.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await expect.poll(() => store<boolean>(page, 's.app.connected'), { timeout: 15_000 }).toBe(true);
  expect(await store<string>(page, 's.app.url')).toContain('#/account');
});

test('right after a typed request, Enter keeps and Ctrl Z undoes from the command bar', async ({ page }) => {
  await openStudio(page);
  const before = shopFile('src/components/CouponField.tsx');
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  const bar = page.getByRole('textbox', { name: 'Describe a change' });
  await bar.fill('rename to Use code');
  await bar.press('Enter');
  // The island says which keys decide, and they work with focus still in the empty command bar.
  await expectIsland(page, new RegExp(`Rename.*${literally((await keyNames(page)).keepUndo)}`));
  await expect(bar).toBeFocused();
  await bar.press('Control+z');
  await expectIsland(page, /Undone/);
  expect(shopFile('src/components/CouponField.tsx')).toBe(before);
  await bar.fill('rename to Use code');
  await bar.press('Enter');
  await expectIsland(page, /Rename/);
  await bar.press('Enter');
  await expectIsland(page, /Kept/);
  expect(await store<string>(page, 's.changes[0].status')).toBe('kept');
});

test('while a preview waits, text being typed keeps its own undo', async ({ page }) => {
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  const bar = page.getByRole('textbox', { name: 'Describe a change' });
  await bar.fill('rename to Use code');
  await bar.press('Enter');
  await expectIsland(page, /Rename/);
  await bar.pressSequentially('make it', { delay: 20 });
  await bar.press('Control+z');
  await page.waitForTimeout(400);
  expect(await store<number>(page, "s.changes.filter((c) => c.status === 'preview').length")).toBe(1);
  await expectIsland(page, /Rename/);
});

test('a request asked while another runs waits its turn, and every change made is shown', async ({ page }) => {
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  const bar = page.getByRole('textbox', { name: 'Describe a change' });
  // The first request (to the AI stand-in) is held on its way until the second has been asked.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let sent = 0;
  await page.route('**/api/intent', async (route) => {
    if (++sent === 1) await held;
    await route.continue();
  });
  await bar.fill('fix the coupon discount');
  await bar.press('Enter');
  await bar.fill('rename to Use code');
  await bar.press('Enter');
  // The quick edit asked meanwhile waits its turn, in view, instead of racing the first.
  await expect(page.locator('[data-island] [data-waiting="1"]')).toBeVisible();
  await expect(page.locator('[data-island]')).toContainText('next: “rename to Use code”');
  expect(sent).toBe(1);
  release();
  await expectIsland(page, /2 previews/);
  const onServer = ((await (await fetch(`${STUDIO}/api/changes`)).json()) as { changes: { id: string; status: string }[] }).changes.filter((c) => c.status === 'preview').map((c) => c.id);
  const shown = await store<string[]>(page, "s.changes.filter((c) => c.status === 'preview').map((c) => c.id)");
  expect(shown).toHaveLength(2);
  expect([...shown].sort()).toEqual([...onServer].sort());
});

test('a quick edit that can’t go further offers the AI, and the design system’s file', async ({ page }) => {
  await openStudio(page);
  const pay = await appPoint(page, 'pay-button');
  await page.mouse.click(pay.x, pay.y);
  const bar = page.getByRole('textbox', { name: 'Describe a change' });
  await bar.fill('make it bigger');
  await bar.press('Enter');
  const island = page.locator('[data-island]');
  await expectIsland(page, /already the largest size/);
  await expect(island.getByRole('button', { name: 'Open Button.tsx' })).toBeVisible();
  const request = page.waitForRequest((r) => r.url().endsWith('/api/intent') && r.method() === 'POST');
  await island.getByRole('button', { name: 'Ask the AI anyway' }).click();
  expect(JSON.parse((await request).postData() ?? '{}')).toMatchObject({ text: 'make it bigger', ai: true });
  await expectIsland(page, /real Claude/);
});

test('an app linked by its address only says why it can’t change code, and offers to link its folder', async ({ page }) => {
  const post = async (route: string, body: unknown) => (await fetch(`${STUDIO}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const site = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Plain page</title><button>Buy</button>');
  });
  await new Promise<void>((ok) => site.listen(0, ok));
  const { probe } = await post('/apps/probe', { url: `http://localhost:${(site.address() as AddressInfo).port}/` });
  const { app } = await post('/apps', { probe, open: true });
  try {
    await openStudio(page);
    const bar = page.getByRole('textbox', { name: 'Describe a change' });
    await bar.fill('make the button bigger');
    await bar.press('Enter');
    await expectIsland(page, /linked by its address only, so the studio can’t see its code/);
    await page.locator('[data-island]').getByRole('button', { name: 'Link its folder…' }).click();
    await expect(page.locator('[data-launcher]')).toBeVisible();
    // Its folder becomes this app's code: the same app, not a second one.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-plain-'));
    fs.writeFileSync(path.join(folder, 'index.html'), '<!doctype html><title>Plain page</title><button>Buy</button>');
    const dialog = page.getByRole('dialog', { name: 'Link an app' });
    await dialog.getByRole('textbox', { name: 'Folder' }).fill(folder);
    await dialog.locator('[data-use-folder]').click();
    await dialog.locator('[data-link-confirm]').click();
    await expect(dialog).toHaveCount(0);
    const { apps: after } = (await (await fetch(`${STUDIO}/api/apps`)).json()) as { apps: { id: string; root: string | null }[] };
    expect(after.filter((a) => a.root === folder || a.id === app.id)).toEqual([expect.objectContaining({ id: app.id, root: folder })]);
  } finally {
    const { apps } = (await (await fetch(`${STUDIO}/api/apps`)).json()) as { apps: { id: string; root: string | null }[] };
    await post(`/apps/${apps.find((a) => a.root?.endsWith('.e2e-shop'))!.id}/open`, { decide: 'undo' });
    await fetch(`${STUDIO}/api/apps/${app.id}`, { method: 'DELETE' });
    site.close();
  }
});

test('text the code computes goes to Claude instead of a blind edit', async ({ page }) => {
  await openStudio(page);
  const pay = await appPoint(page, 'pay-button');
  await page.mouse.click(pay.x, pay.y);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('rename to Place order');
  await page.keyboard.press('Enter');
  // “Pay {total}” is computed, so the quick path declines and the (test double) agent answers.
  await expectIsland(page, /real Claude/);
});

test('inspector props edit the design system value', async ({ page }) => {
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await page.getByRole('tab', { name: /Inspect/ }).click();
  await page.getByRole('button', { name: 'danger', exact: true }).click();
  await expectIsland(page, /variant secondary → danger/);
  expect(shopFile('src/components/CouponField.tsx')).toContain('variant="danger"');
  await page.getByRole('button', { name: /Undo/ }).first().click();
  await expectIsland(page, /Undone/);
});

test('questions get an answer with clickable file references', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('why is the total wrong?');
  await page.keyboard.press('Enter');
  await expectIsland(page, /calcTotals/);
  await expect(page.getByRole('button', { name: 'src/lib/pricing.ts:32' })).toBeVisible();
});

test('the code in Changes takes the new theme’s colours when the theme changes', async ({ page }) => {
  await openStudio(page, { onboarded: true, theme: 'light' });
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make it bigger');
  await page.keyboard.press('Enter');
  const token = page.locator('[data-change]').first().locator('.font-mono span[style*="color"]').first();
  await expect(token).toBeVisible();
  const colour = () => token.evaluate((el) => getComputedStyle(el).color);
  const light = await colour();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('dark theme');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect.poll(colour).not.toBe(light);
  await page.keyboard.press('ControlOrMeta+z');
});

test('command palette, modes and theme', async ({ page }) => {
  await openStudio(page, { onboarded: true, theme: 'system' });
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder('Search commands…').fill('use');
  await page.getByRole('option', { name: /Use: click through the app/ }).click();
  await expect.poll(() => store<string>(page, 's.mode')).toBe('use');
  await page.keyboard.press('e');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('edit');
  // Following a light system, the palette offers the dark theme, found by the word “dark”, and it changes what shows.
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder('Search commands…').fill('dark');
  await page.getByRole('option', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder('Search commands…').fill('theme');
  await expect(page.getByRole('option', { name: 'Switch to light theme' })).toBeVisible();
  // The key that opened it closes it, even with the focus in its search box.
  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('Search commands…')).toBeHidden();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Close' }).first().click();
});

test('voice settings offer the missing on-device model’s download, and this install’s command', async ({ page }) => {
  await page.route('**/models/moonshine/tiny/encoder_model.onnx', (r) => r.fulfill({ status: 404 }));
  await openStudio(page, { onboarded: true, theme: 'dark', voice: { engine: 'auto' } });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  const missing = page.locator('[data-model="unavailable"]');
  await expect(missing).toContainText('Download the voice model (28 MB)', { timeout: 20_000 });
  // Run from this repository: its own setup script (an npm install says npx @saywright/studio setup).
  await expect(missing).toContainText('or run npm run setup');
  // The download itself is the server's (stood in for here); then the model loads.
  await page.unroute('**/models/moonshine/tiny/encoder_model.onnx');
  await page.route('**/api/voice-model', (r) => (r.request().method() === 'POST' ? r.fulfill({ json: { ready: true, mb: 28, setup: 'npm run setup' } }) : r.fallback()));
  await missing.getByRole('button', { name: /Download the voice model/ }).click();
  await expect(page.locator('[data-model="ready"]')).toBeVisible({ timeout: 30_000 });
});

test('the studio explains what needs an AI, and how to connect one', async ({ page }) => {
  // The test server uses the AI test double, so check the copy instead: quick edits need no AI.
  await openStudio(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  // What leaves the computer, said the same way everywhere, and spelled out on request.
  await expect(page.locator('[data-privacy]').first()).toContainText('Your code leaves it only when you ask the AI something');
  await page.getByRole('button', { name: 'What’s sent?' }).first().click();
  await expect(page.locator('[data-whats-sent]')).toContainText('Size, variant, text, move and remove are done on this computer. Nothing is sent.');
  await page.keyboard.press('Escape');
  // Plans, keys, this computer and other providers are all offered.
  for (const section of ['Your plans', 'API keys', 'On this computer', 'Other providers']) await expect(page.getByRole('heading', { name: section })).toBeVisible();
  await expect(page.locator('[data-connection="claude-code"]')).toBeVisible();
  await expect(page.locator('[data-connection="anthropic"]')).toBeVisible();
  // Something answers requests here (the stand-in): no "Connect an AI" first, and routing waits under Advanced.
  await expect(page.locator('[data-connect-ai]')).toHaveCount(0);
  await expect(page.locator('[data-ai-advanced]')).toContainText('Who does what');
});

test('the top bar always says who answers and what today cost: with no AI, that quick edits are free', async ({ page }) => {
  await openStudio(page);
  const chip = page.getByRole('banner').getByRole('button', { name: /^AI \(test\)/ });
  await expect(chip).toHaveText(/^\s*AI \(test\)\s*·\s*\$0\.00 today$/);
  await chip.click();
  await expect.poll(() => store<string>(page, 's.settingsTab')).toBe('ai');
  await page.getByRole('button', { name: 'Close' }).first().click();

  // The same studio as if nothing were connected (the test server always has the AI stand-in).
  const noAi = async (route: Route) => {
    const res = await route.fetch();
    const json = await res.json();
    if (json.ai) json.ai.ready = false;
    else json.ready = false;
    await route.fulfill({ response: res, json });
  };
  await page.route('**/api/status', noAi);
  await page.route(/\/api\/ai(\?.*)?$/, noAi);
  await page.reload();
  const none = page.getByRole('banner').getByRole('button', { name: /^No AI/ });
  await expect(none).toHaveText(/^\s*No AI\s*·\s*quick edits are free$/);
  await none.click();
  const connect = page.locator('[data-connect-ai]');
  for (const way of ['Use a plan you pay for', 'Paste an API key', 'Run a model on this computer']) await expect(connect).toContainText(way);
  await expect(page.locator('[data-ai-advanced]')).toHaveCount(0);
});
