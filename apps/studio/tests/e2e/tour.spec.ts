/**
 * The quick-start tour, as a newcomer meets it: the welcome, the sample shop, then coach marks on the live studio,
 * each moving on when you do what it asks (point, say or type, keep), then the code, the AI and what it costs, and
 * where testing and reviews live. It never takes the studio over. Skip tour or Escape ends it for good, on this
 * computer; Help and the command palette bring it back. Its words follow the AI and the microphone.
 */
import { expect, test, type Page } from '@playwright/test';
import { appPoint, expectIsland, forgetTour, keyNames, openStudio, resetAll, shopFile, store, STUDIO, waitForApp } from './helpers';

const call = async <T = Record<string, unknown>,>(method: string, route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${STUDIO}/api${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await res.json()) as T;
};
type Apps = { apps: { id: string; root: string | null }[] };
const shopId = async () => (await call<Apps>('GET', '/apps')).apps.find((a) => a.root?.endsWith('.e2e-shop'))!.id;
const tourSeen = async () => (await call<{ tourSeen: boolean }>('GET', '/status')).tourSeen;
const step = (page: Page, title: string) => page.getByRole('dialog', { name: title });
const inCard = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[data-tour-card]'));
const PAY_LG = '<Button size="lg" fullWidth onClick={onPay}';

test.beforeEach(async () => {
  await resetAll();
  await forgetTour();
});
test.afterEach(async () => {
  await call('POST', `/apps/${await shopId()}/open`, { decide: 'undo' });
});

test('first run: the welcome, the sample shop, then a tour whose steps move on as you do them', async ({ page, browser }) => {
  const shop = await shopId();
  await call('POST', '/apps/close');
  await page.addInitScript(() => localStorage.setItem('saywright.settings', JSON.stringify({ state: { theme: 'dark' }, version: 1 })));
  // A studio with nothing linked yet shows the welcome; its sample shop is this suite's copy of the shop.
  let fresh = true;
  await page.route('**/api/apps', async (route) => {
    if (!fresh || route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), apps: [], active: null } });
  });
  await page.route('**/api/apps/sample', async (route) => route.fulfill({ response: await route.fetch({ url: `${STUDIO}/api/apps/${shop}/open`, method: 'POST', postData: '{}' }) }));
  await page.goto('/');
  const welcome = page.locator('[data-welcome]');
  await expect(welcome).toContainText('A one-minute tour starts once your app is open.');
  // One welcome at a time: no tour over the app list, and no setup dialog after it.
  await page.waitForTimeout(800);
  await expect(page.locator('[data-tour-card]')).toHaveCount(0);
  fresh = false;
  await welcome.locator('[data-try-sample]').click();

  const point = step(page, 'Point at something');
  await expect(point).toBeVisible({ timeout: 30_000 });
  await expect(point).toContainText('1 of 8');
  await expect(point).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Set up Saywright' })).toHaveCount(0);

  // Point: clicking something in the app selects it, and the tour moves on.
  const pay = await appPoint(page, 'pay-button');
  await page.mouse.click(pay.x, pay.y);
  const { enter, undo } = await keyNames(page);
  await expect(step(page, 'Say what to change')).toContainText(`Hold Space and say it, or type it here and press ${enter}`);
  // Say: a typed request makes a live preview.
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make it smaller');
  await page.keyboard.press('Enter');
  await expect(step(page, 'Keep it or undo it')).toContainText(`This is a live preview: your file and your app have already changed. ${enter} keeps it, ${undo} puts both back.`);
  expect(shopFile('src/components/OrderSummary.tsx')).not.toContain(PAY_LG);
  // Keep: Enter keeps it.
  await page.keyboard.press('Enter');
  const code = step(page, 'See the code');
  await expect(code).toBeVisible();
  await expect(page.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-change]').first()).toContainText('Kept');
  await expect(page.locator('[data-change]').first()).toContainText('src/components/OrderSummary.tsx');
  await expect(page.locator('[data-tour-ring]')).toHaveCount(2);

  // The rest show something, and wait for Next.
  await page.locator('[data-tour-next]').click();
  await expect(step(page, 'Your AI')).toContainText('Quick edits stay instant and free. Anything bigger goes to the test stand-in, which costs nothing.');
  await page.locator('[data-tour-next]').click();
  // What the studio is for: the mode switcher and the Test tab are ringed. (This suite's shop is a copy linked as any app is.)
  await expect(step(page, 'Say the bug, get the test')).toContainText('Press R for Write test. Use your app as usual, then point at a value that is wrong and say what it should be: “this should show $80.80”. You get a Playwright test that fails on the bug. Your AI’s fix is kept only when that same test passes.');
  await expect(page.locator('[data-tour-ring]')).toHaveCount(2);
  await page.locator('[data-tour-next]').click();
  await expect(step(page, 'Test and review')).toContainText('Record session: use your app and talk, then get a report with evidence.');
  await page.locator('[data-tour-next]').click();
  const done = step(page, 'You’re set');
  await expect(done).toContainText(`Press ? for phrases and shortcuts, and ${(await keyNames(page)).palette} to find any action by name.`);
  await expect(done.getByRole('button', { name: 'Skip tour' })).toHaveCount(0);
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('[data-tour-card]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Help' })).toBeFocused();
  // The change is kept, and the tour remembered: in this browser, and on this computer for any other.
  expect(shopFile('src/components/OrderSummary.tsx')).not.toContain(PAY_LG);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('saywright.settings')!).state.onboarded)).toBe(true);
  expect(await tourSeen()).toBe(true);
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const second = await other.newPage();
  await second.goto(`${STUDIO}/`);
  await waitForApp(second);
  await second.waitForTimeout(1500);
  await expect(second.locator('[data-tour-card]')).toHaveCount(0);
  await other.close();
});

test('it never takes the studio over; Skip tour and Escape end it for good, and Help and the palette bring it back', async ({ page }) => {
  await openStudio(page, { theme: 'light' });
  const card = page.locator('[data-tour-card]');
  const point = step(page, 'Point at something');
  await expect(point).toBeFocused({ timeout: 15_000 });
  // Not a modal: nothing is inert, the studio's keys work, and Tab moves on out of the card.
  await expect(point).not.toHaveAttribute('aria-modal', 'true');
  expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0);
  await page.keyboard.press('u');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('use');
  await expect(point).toContainText('Press E for Edit mode, then click anything in it.');
  await page.keyboard.press('e');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('edit');
  await card.locator('[data-tour-next]').focus();
  await page.keyboard.press('Tab');
  expect(await inCard(page)).toBe(false);

  // Skip tour: gone, and says where to find it again.
  await card.getByRole('button', { name: 'Skip tour' }).click();
  await expect(card).toHaveCount(0);
  await expectIsland(page, /Tour closed\. Take it again any time from Help/);
  expect(await tourSeen()).toBe(true);
  await page.reload();
  await waitForApp(page);
  await page.waitForTimeout(1500);
  await expect(card).toHaveCount(0);

  // Help → Take the tour, from the first step; Escape in the card ends it, and focus goes back to Help.
  await page.getByRole('button', { name: 'Help' }).click();
  await page.getByRole('dialog', { name: 'Phrases and shortcuts' }).getByRole('button', { name: 'Take the tour' }).click();
  await expect(point).toBeFocused();
  await expect(point).toContainText('1 of 8');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Help' })).toBeFocused();

  // The palette has it too. Escape elsewhere ends it as well, before clearing what is selected.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('tour');
  await page.keyboard.press('Enter');
  await expect(point).toBeVisible();
  const pay = await appPoint(page, 'pay-button');
  await page.mouse.click(pay.x, pay.y);
  await expect(step(page, 'Say what to change')).toBeVisible();
  expect(await inCard(page)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  expect(await store<string | null>(page, 's.selection?.name ?? null')).toBe('Button');
});

test('its words follow the AI and the microphone: with no AI, quick edits are free and it offers to connect one', async ({ page }) => {
  // No AI connected, and no microphone: the tour talks about typing, and about what an AI is for.
  await page.route('**/api/status', async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    await route.fulfill({ response: res, json: { ...s, ai: { ...s.ai, ready: false, source: null, who: null } } });
  });
  await openStudio(page, { theme: 'dark' });
  await expect(page.getByRole('button', { name: /No AI/ })).toBeVisible();
  const card = page.locator('[data-tour-card]');
  await expect(step(page, 'Point at something')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const s = (window as any).__saywrightStore;
    s.set({ voice: { ...s.get().voice, supported: false } });
  });
  await card.locator('[data-tour-next]').click();
  const say = step(page, 'Say what to change');
  await expect(say).toContainText(`Type it here and press ${(await keyNames(page)).enter}: “make it smaller”, “rename to Place order”.`);
  await expect(say).not.toContainText('Space');
  await expect(say.getByRole('button', { name: 'Check your mic' })).toHaveCount(0);
  await card.locator('[data-tour-next]').click();
  await expect(step(page, 'Keep it or undo it')).toContainText('Each change arrives as a live preview');
  await card.locator('[data-tour-next]').click();
  await card.locator('[data-tour-next]').click();
  const ai = step(page, 'Bigger changes need an AI');
  await expect(ai).toContainText('Size, variant, text, move and remove are quick edits: instant, free and offline.');
  // Connect an AI opens Settings → AI; the tour waits behind it and goes on after.
  await ai.getByRole('button', { name: 'Connect an AI' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Nothing is promised of an AI that isn't connected.
  const test = step(page, 'Say the bug, get the test');
  await expect(test).toContainText('You get a Playwright test that fails on the bug. With an AI connected, its fix is kept only when that same test passes.');
  await expect(test).toBeFocused();
  await card.locator('[data-tour-next]').click();
  await expect(step(page, 'Test and review')).toContainText('with an AI connected, Autopilot tries your app like a tester');
});

test('with a microphone, its mic check opens the voice step of the setup and comes back to the tour', async ({ page }) => {
  await openStudio(page, { theme: 'dark' });
  const card = page.locator('[data-tour-card]');
  await expect(step(page, 'Point at something')).toBeVisible({ timeout: 15_000 });
  await card.locator('[data-tour-next]').click();
  await step(page, 'Say what to change').getByRole('button', { name: 'Check your mic' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up Saywright' });
  await expect(setup.getByText('Talk to it')).toBeVisible();
  await expect(card).toHaveCount(0);
  await setup.getByRole('button', { name: 'Skip, I’ll type' }).click();
  await expect(setup).toHaveCount(0);
  await expect(step(page, 'Say what to change')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Describe a change' })).toBeFocused();
  // Still touring: no “you’re set” yet.
  await expect(page.locator('[data-island]')).not.toContainText('You’re set');
});
