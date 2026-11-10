/**
 * Replay & verify: after a fix, "Verify fixes" plays the session's steps again
 * in the app and says, finding by finding, what is fixed and what still
 * happens. Here with a real recorded session (the app throws when a coupon is
 * applied) and with a value the tester said the total should show.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { appPoint, E2E_SHOP, openStudio, resetAll, SHOP_URL, shopFile, STUDIO } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
test.beforeEach(async ({ page }) => {
  await resetAll();
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
});
test.afterAll(() => resetAll());

const post = async (route: string, body: unknown) => (await fetch(`${STUDIO}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const detail = async (id: string) => (await (await fetch(`${STUDIO}/api/sessions/${id}`)).json()) as { meta: { status: string }; verification: { replay: string; steps: { total: number; done: number } } | null; analysis: { issues: { kind: string; el?: { locator?: string } }[] } };

/** Whether the on-device recogniser can transcribe English here. */
async function englishSpeech(): Promise<boolean> {
  const status = (await (await fetch(`${STUDIO}/api/speech/status`)).json()) as { runtime: string; active: Record<string, string | null> };
  return status.runtime !== 'missing' && status.runtime !== 'failed' && !!status.active.en;
}

/** “This should show eighty dollars eighty”, a second into narration that starts at `t`, sent as a microphone sends it. */
async function narrate(id: string, t: number): Promise<void> {
  const pcm = fs.readFileSync(path.join(here, '../fixtures/speech/expect.wav')).subarray(44);
  const quiet = Buffer.alloc(16000 * 2);
  const audio = Buffer.concat([quiet, pcm, quiet, quiet]);
  for (let at = 0; at < audio.length; at += 16000) {
    await fetch(`${STUDIO}/api/sessions/${id}/audio?t=${t + at / 32}`, { method: 'POST', body: audio.subarray(at, at + 16000), headers: { 'Content-Type': 'text/plain' } });
  }
}

function editShop(rel: string, from: string, to: string): void {
  const file = path.join(E2E_SHOP, rel);
  const code = fs.readFileSync(file, 'utf8');
  expect(code).toContain(from);
  fs.writeFileSync(file, code.replace(from, to));
}

/** The app has reloaded with this code. */
async function appHas(page: Page, check: () => boolean | Promise<boolean>): Promise<void> {
  await expect.poll(check, { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(800);
}

async function sessionNamed(name: string): Promise<string> {
  let id = '';
  await expect
    .poll(
      async () => {
        const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string; name: string; status: string }[] };
        const s = sessions.find((x) => x.name === name);
        id = s?.id ?? '';
        return s?.status;
      },
      { timeout: 60_000 },
    )
    .toBe('ready');
  return id;
}

/** "Verify fixes" (or "Replay again"): the steps play on the stage, then the report comes back with the verdicts. */
async function verify(page: Page, button: string): Promise<void> {
  await page.locator(button).click();
  // Played on the stage, where the replay says which step it is on and boxes each target.
  await expect(page.locator('[data-island="replay"]')).toBeVisible();
  await expect(page.locator('[data-replay-target]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-replay-shield]')).toBeVisible();
  await expect(page.locator('[data-verification="done"]')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('[data-island="replay"]')).toHaveCount(0);
}

test('a real session: the error still happens, then after the fix it is gone', async ({ page }) => {
  test.setTimeout(150_000);
  // The bug: applying a coupon throws.
  editShop('src/components/CouponField.tsx', '  const apply = () => {\n', "  const apply = () => {\n    if (code) throw new Error('The coupon service is down');\n");
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await appHas(page, () => shopFile('src/components/CouponField.tsx').includes('coupon service is down'));

  // The tester's session: type a coupon, apply it, it fails.
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Coupon at checkout');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const id = await sessionNamed('Coupon at checkout');
  await page.goto(`/report/${id}`);
  const finding = page.locator('[data-findings] article', { hasText: 'coupon service is down' }).first();
  await expect(finding).toBeVisible();
  await expect(finding).not.toHaveAttribute('data-verdict');

  // Not fixed yet: the replay runs into the same error.
  await verify(page, '[data-verify]');
  await expect(finding).toHaveAttribute('data-verdict', 'still');
  await expect(finding.locator('[data-verdict-why]')).toContainText('It happened again');
  await expect(page.locator('[data-verify-steps]')).toHaveText('Replayed 2 of 2 steps');
  await expect(page.locator('[data-verify-summary]')).toContainText('still happen');
  // The app is back as it was, and the replay is part of this session, not one of its own.
  const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { name: string }[] };
  expect(sessions.filter((s) => s.name.startsWith('Replay of'))).toEqual([]);
  const first = (await detail(id)).verification!.replay;

  // Fixed in the code: the same steps, no error.
  editShop('src/components/CouponField.tsx', "    if (code) throw new Error('The coupon service is down');\n", '');
  await appHas(page, () => !shopFile('src/components/CouponField.tsx').includes('coupon service is down'));
  await verify(page, '[data-verify-again]');
  await expect(finding).toHaveAttribute('data-verdict', 'fixed');
  await expect(finding.locator('[data-verdict-why]')).toContainText('It didn’t happen in the replay.');
  // The coupon really was applied in the app by the replay.
  await expect(app.getByTestId('summary-discount')).toBeVisible();
  // Only the latest replay is kept.
  expect((await detail(id)).verification!.replay).not.toBe(first);
  expect((await fetch(`${STUDIO}/api/sessions/${first}`)).status).toBe(404);

  // Copied for a pull request, with the verdicts.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy as Markdown' }).click();
  const md = await page.evaluate(() => navigator.clipboard.readText());
  expect(md).toContain('**Checked by a replay:** 1 fixed. Replayed 2 of 2 steps.');
  expect(md).toMatch(/coupon service is down\*\* · ✅ Fixed: It didn’t happen in the replay\./);

  // In Arabic too.
  await page.getByRole('radio', { name: 'العربية' }).click();
  await expect(finding.locator('[data-verdict]').first()).toHaveText('أُصلحت');
});

test('a value the tester said the total should show is read in the app when the replay gets there', async ({ page }) => {
  test.setTimeout(150_000);
  test.skip(!(await englishSpeech()), 'No English speech model here');
  // The session: apply SAVE20, then point at the total and say what it should show ($98.00 − 20% of the items = $80.80).
  const { session } = await post('/sessions', { name: 'Total after coupon', appUrl: `${SHOP_URL}/`, source: 'studio', lang: 'en' });
  const t = session.startedAt as number;
  const field = { src: 'src/components/CouponField.tsx:44:7', name: 'TextField', tag: 'input', role: 'textbox', label: 'Coupon', text: '', rect: [10, 10, 200, 36], locator: "page.getByPlaceholder('Coupon code')" };
  const apply = { src: 'src/components/CouponField.tsx:45:7', name: 'Button', tag: 'button', role: 'button', label: 'Apply', text: 'Apply', rect: [220, 10, 80, 36], locator: "page.getByRole('button', { name: 'Apply' })" };
  const total = { src: 'src/components/OrderSummary.tsx:24:9', name: 'SummaryRow', tag: 'div', role: null, label: 'Total $78.40', text: 'Total $78.40', rect: [10, 300, 300, 40], locator: "page.getByTestId('summary-total')" };
  await post(`/sessions/${session.id}/events`, {
    page: 'p1',
    events: [
      { seq: 1, t: t + 100, type: 'page', url: `${SHOP_URL}/`, title: 'Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false },
      { seq: 2, t: t + 1000, type: 'input', value: 'SAVE20', el: field },
      { seq: 3, t: t + 1600, type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: apply },
      { seq: 4, t: t + 2500, type: 'hover', ms: 6000, el: total },
    ],
  });
  await narrate(session.id, t + 2500);
  await post(`/sessions/${session.id}/stop`, {});
  await expect.poll(async () => (await detail(session.id)).meta.status, { timeout: 60_000 }).toBe('ready');
  // Heard, and said about the total.
  expect((await detail(session.id)).analysis.issues.find((i) => i.kind === 'said')?.el?.locator).toBe("page.getByTestId('summary-total')");

  await openStudio(page);
  await page.goto(`/report/${session.id}`);
  const finding = page.locator('[data-findings] article', { hasText: /should show/i }).first();
  await expect(finding).toBeVisible();
  await verify(page, '[data-verify]');
  await expect(finding).toHaveAttribute('data-verdict', 'still');
  await expect(finding.locator('[data-verdict-why]')).toContainText('$78.40, not $80.80');

  // The fix: 20% of the items, not of the items and the shipping.
  editShop('src/lib/pricing.ts', 'round2((subtotal + shipping) * rate)', 'round2(subtotal * rate)');
  await appHas(page, () => shopFile('src/lib/pricing.ts').includes('round2(subtotal * rate)'));
  await verify(page, '[data-verify-again]');
  await expect(finding).toHaveAttribute('data-verdict', 'fixed');
  await expect(finding.locator('[data-verdict-why]')).toContainText('It shows $80.80 now.');
});

test('a value said while pointing at it in the studio is checked on that element, before and after the fix', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!(await englishSpeech()), 'No English speech model here');
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Total said while pointing');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  const { session } = (await (await fetch(`${STUDIO}/api/sessions/active`)).json()) as { session: { id: string } };
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await expect(app.getByTestId('summary-total')).toContainText('$78.40');

  // The mouse rests on the total in the studio's frame while the tester says what it should show.
  const total = await appPoint(page, 'summary-total', 0.3);
  await page.mouse.move(total.x, total.y, { steps: 4 });
  await page.waitForTimeout(300);
  await narrate(session.id, Date.now());
  await page.waitForTimeout(4500);
  const away = await appPoint(page, 'summary-subtotal');
  await page.mouse.move(away.x, away.y, { steps: 4 });
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await detail(session.id)).meta.status, { timeout: 90_000 }).toBe('ready');

  // The studio's pointing named the total the way a test finds it, and the sentence is about it.
  const events = fs
    .readFileSync(path.join(E2E_SHOP, '.saywright/sessions', session.id, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; el?: { locator?: string } });
  expect(events.some((e) => e.type === 'point' && e.el?.locator === "page.getByTestId('summary-total')")).toBe(true);
  expect((await detail(session.id)).analysis.issues.find((i) => i.kind === 'said')?.el?.locator).toBe("page.getByTestId('summary-total')");

  await page.goto(`/report/${session.id}`);
  const finding = page.locator('[data-findings] article', { hasText: /should show/i }).first();
  await expect(finding).toBeVisible();
  await verify(page, '[data-verify]');
  await expect(finding).toHaveAttribute('data-verdict', 'still');
  await expect(finding.locator('[data-verdict-why]')).toContainText('$78.40, not $80.80');

  editShop('src/lib/pricing.ts', 'round2((subtotal + shipping) * rate)', 'round2(subtotal * rate)');
  await appHas(page, () => shopFile('src/lib/pricing.ts').includes('round2(subtotal * rate)'));
  await verify(page, '[data-verify-again]');
  await expect(finding).toHaveAttribute('data-verdict', 'fixed');
  await expect(finding.locator('[data-verdict-why]')).toContainText('It shows $80.80 now.');
  await expect(page.locator('[data-verify-summary]')).not.toContainText('couldn’t be checked');
});

test('an element found by its place in the code is found again after a fix moves it', async ({ page }) => {
  await openStudio(page);
  const app = page.frameLocator('iframe');
  const note = app.getByText('Free returns within 30 days');
  const before = await note.evaluate((el) => ({ src: el.getAttribute('data-ds-src') ?? '', tag: el.tagName.toLowerCase(), name: el.getAttribute('data-ds-name') || el.tagName.toLowerCase(), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim() }));
  expect(before.src).toMatch(/OrderSummary\.tsx:\d+:\d+$/);
  const locator = `page.locator('[data-ds-src="${before.src}"]')`;
  // A fix adds three lines above it: the Pay button now sits where the note was.
  editShop('src/components/OrderSummary.tsx', '  return (\n    <Card title="Order summary">', '  // Totals come from calcTotals.\n  // Coupons apply to the items.\n  // Shipping is flat.\n  return (\n    <Card title="Order summary">');
  await expect.poll(() => note.evaluate((el) => el.getAttribute('data-ds-src')), { timeout: 15_000 }).not.toBe(before.src);
  const replay = (like?: { tag: string; name: string; text: string }) =>
    page.evaluate(([loc, l]) => (window as unknown as { __saywright: { bridge: { replay: (...a: unknown[]) => Promise<{ ok: boolean; text?: string }> } } }).__saywright.bridge.replay(loc, undefined, true, l), [locator, like] as const);
  // By its old place alone, the replay would act on the wrong thing.
  const blind = await replay();
  expect(blind.ok ? blind.text : '').not.toContain('Free returns');
  // Knowing what it was, it is found where it moved to.
  const found = await replay({ tag: before.tag, name: before.name, text: before.text });
  expect(found).toMatchObject({ ok: true, text: 'Free returns within 30 days' });
});

test('a row’s button is recorded by its row before the click removes it, and a step that matches several is not guessed', async ({ page }) => {
  await openStudio(page);
  const frame = page.frames().find((f) => f.url().startsWith(SHOP_URL))!;
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Delete a row');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  // Every row has a “Delete” button; deleting a row removes it at once.
  await frame.evaluate(() => {
    const list = document.createElement('ul');
    list.id = 'rows';
    list.innerHTML = ['Alpha', 'Beta', 'Gamma'].map((n) => `<li><span>${n}</span> <button>Delete</button></li>`).join('');
    document.body.prepend(list);
    list.addEventListener('click', (e) => (e.target as Element).closest('li')?.remove());
  });
  await frame.locator('#rows li', { hasText: 'Beta' }).getByRole('button', { name: 'Delete' }).click();
  await expect(frame.locator('#rows li')).toHaveCount(2);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const id = await sessionNamed('Delete a row');
  const steps = ((await (await fetch(`${STUDIO}/api/sessions/${id}`)).json()) as { analysis: { steps: { kind: string; locator?: string }[] } }).analysis.steps;
  expect(steps.find((s) => s.kind === 'click')?.locator).toContain('Beta');
  // The same “Delete” on every row: the replay doesn't press the first one.
  const replay = (loc: string) => page.evaluate((l) => (window as unknown as { __saywright: { bridge: { replay: (...a: unknown[]) => Promise<{ ok: boolean; error?: string }> } } }).__saywright.bridge.replay(l, { kind: 'click' }), loc);
  expect(await replay("page.getByRole('button', { name: 'Delete' })")).toMatchObject({ ok: false, error: 'ambiguous' });
  await expect(frame.locator('#rows li')).toHaveCount(2);
});
