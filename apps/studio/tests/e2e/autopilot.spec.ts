/**
 * Autopilot on the sample shop, with the test double for the AI (it knows this shop): it reads the checkout, applies
 * SAVE20, sees the discount taken from shipping too, and the run ends in the session's report, with its steps in the
 * timeline and the problem among the findings, tied to the coupon's code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_SHOP, openStudio, resetAll, SHOP_URL, store, STUDIO, waitForApp } from './helpers';

test.beforeEach(() => resetAll());

const BANNER = path.join(E2E_SHOP, 'src/components/Banner.tsx');
test.afterEach(() => fs.rmSync(BANNER, { force: true }));

async function detail(id: string) {
  return (await (await fetch(`${STUDIO}/api/sessions/${id}`)).json()) as {
    meta: { name: string; source: string; status: string };
    analysis: { issues: { kind: string; title: string; severity: string; detail: string; src?: string }[]; timeline: { kind: string; text: string; detail?: string }[]; steps: { kind: string; locator?: string }[] };
    report: { findings: { title: string; location: string }[] } | null;
  };
}

/** Start Autopilot on the checkout with the SAVE20 goal, and wait for its report; the session's id. */
async function runAutopilot(page: Page): Promise<string> {
  await page.getByRole('tab', { name: 'Sessions' }).click();
  const card = page.locator('[data-autopilot-card]');
  await card.locator('[data-autopilot-goal]').fill('Apply the SAVE20 coupon at checkout');
  await card.locator('[data-autopilot-start]').click();
  await expect(page.locator('[data-autopilot]')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole('dialog', { name: 'Session report' }).getByText('SAVE20 takes 20% off shipping too').first()).toBeVisible({ timeout: 120_000 });
  const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string; source: string }[] };
  return sessions.find((s) => s.source === 'autopilot')!.id;
}

test('what Autopilot’s own clicks move is no layout shift of the app’s', async ({ page }) => {
  // A banner that comes in above the whole app at the first click on it, pushing everything down.
  fs.writeFileSync(
    BANNER,
    `import { useEffect, useState } from 'react';
export function Banner() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const on = () => setShown(true);
    addEventListener('click', on, true);
    return () => removeEventListener('click', on, true);
  }, []);
  return shown ? <div className="banner" style={{ height: 420, background: '#eee' }}>Thanks for shopping with us</div> : null;
}
`,
  );
  const app = path.join(E2E_SHOP, 'src/App.tsx');
  const code = fs.readFileSync(app, 'utf8');
  fs.writeFileSync(app, code.replace("import { Header } from './components/Header';", "import { Header } from './components/Header';\nimport { Banner } from './components/Banner';").replace('<Header route={route} />', '<Banner />\n      <Header route={route} />'));
  await openStudio(page);
  await waitForApp(page);
  const d = await detail(await runAutopilot(page));
  // The banner came in at its click, and moved the page: that was the click's doing.
  await expect(page.frameLocator('iframe').getByText('Thanks for shopping with us')).toBeVisible();
  expect(d.analysis.issues.filter((g) => g.kind === 'performance' && /jumps/.test(g.title))).toEqual([]);
});

test('Autopilot uses the app like a tester and ends in a report of what it found', async ({ page }) => {
  await openStudio(page);
  await waitForApp(page);
  await page.getByRole('tab', { name: 'Sessions' }).click();
  const card = page.locator('[data-autopilot-card]');
  await card.locator('[data-autopilot-goal]').fill('Apply the SAVE20 coupon at checkout');
  // Without permission, it leaves deleting, paying and sending alone.
  await expect(card.getByRole('switch', { name: 'Let it delete, pay, send and sign out' })).not.toBeChecked();
  await card.locator('[data-autopilot-start]').click();

  // It shows what it is doing, step by step, with a way out.
  await expect(page.locator('[data-autopilot]')).toBeVisible();
  await expect(page.locator('[data-autopilot-step]')).toContainText(/Put a product in the cart|Go to the checkout|Try the SAVE20 coupon|Apply it/, { timeout: 20_000 });
  await expect(page.locator('[data-autopilot-stop]')).toBeVisible();

  // The run ends in the session's report, which opens by itself.
  await expect(page.locator('[data-autopilot]')).toHaveCount(0, { timeout: 60_000 });
  const report = page.getByRole('dialog', { name: 'Session report' });
  await expect(report.getByText('SAVE20 takes 20% off shipping too').first()).toBeVisible({ timeout: 120_000 });

  const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string; source: string }[] };
  const d = await detail(sessions.find((s) => s.source === 'autopilot')!.id);
  expect(d.meta.source).toBe('autopilot');
  expect(d.meta.name).toBe('Autopilot: Apply the SAVE20 coupon at checkout');
  // What it did, in the timeline, in order, and as steps a replay or a test can take again.
  const did = d.analysis.timeline.filter((x) => x.text.startsWith('Autopilot: ')).map((x) => x.text);
  expect(did).toEqual(['Autopilot: Typed “SAVE20” into “Coupon”', 'Autopilot: Clicked “Apply”']);
  expect(d.analysis.steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['click', 'fill']));
  // What it saw, as a finding with what it expected, tied to the coupon's code.
  const seen = d.analysis.issues.find((g) => g.kind === 'observed');
  expect(seen).toMatchObject({ title: 'SAVE20 takes 20% off shipping too', severity: 'high' });
  expect(seen?.detail).toContain('Expected: A discount of 20% of the items only');
  expect(seen?.src).toMatch(/CouponField\.tsx:\d+:\d+$/);
  // The app is where the run left it: back in Edit mode, with the coupon applied in the shop.
  expect(await store<string>(page, 's.mode')).not.toBe('use');
  await expect(page.frameLocator('iframe').getByText('SAVE20 applied')).toBeVisible();
});

test('Escape stops a run, which still ends in its report', async ({ page }) => {
  await openStudio(page);
  await waitForApp(page);
  await page.getByRole('tab', { name: 'Sessions' }).click();
  await page.locator('[data-autopilot-start]').click();
  await expect(page.locator('[data-autopilot]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-autopilot]')).toHaveCount(0, { timeout: 30_000 });
  // A stopped run still ends in its report.
  await expect(page.getByRole('dialog', { name: 'Session report' })).toBeVisible({ timeout: 120_000 });
});

test('while Autopilot acts without leave, the page refuses what deletes, pays, sends or signs out, whatever the control says', async ({ page }) => {
  await openStudio(page);
  await waitForApp(page);
  const frame = page.frames().find((f) => f.url().startsWith(SHOP_URL))!;
  // Controls that say nothing risky, each doing something that can't be taken back (the audit's admin page).
  await frame.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'risky-box';
    box.innerHTML = `<button id="r1">Save</button><button id="r2">Tidy</button><button id="r3">Continue</button><button id="r4">Bye</button>
      <form id="f" action="/account/delete" method="post"><button id="r5">Yes, continue</button></form><button id="r6">Fine</button><p id="said"></p>`;
    document.body.prepend(box);
    const said = (t: string) => (document.getElementById('said')!.textContent += ` ${t}`);
    document.getElementById('r1')!.onclick = () => fetch('/api/users/7', { method: 'DELETE' }).then(() => said('deleted'), (e: Error) => said(e.name));
    document.getElementById('r2')!.onclick = () => fetch('/api/cart/clear-and-pay', { method: 'POST' }).catch(() => said('refused'));
    document.getElementById('r3')!.onclick = () => said(confirm('Delete everything?') ? 'confirmed' : 'kept');
    document.getElementById('r4')!.onclick = () => (location.href = '/logout');
    document.getElementById('r6')!.onclick = () => fetch('/api/products').then((r) => said(`products ${r.status}`));
  });
  const sent: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/users\/7|clear-and-pay|\/logout|\/account\/delete/.test(r.url())) sent.push(`${r.method()} ${r.url()}`);
  });
  const bridge = (code: string) => page.evaluate(code);
  const click = (id: string, guard = true) => bridge(`window.__saywright.bridge.replay("page.locator('#${id}')", { kind: 'click', guard: ${guard} })`);
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) await click(id);
  await expect(frame.locator('#said')).toHaveText(' AbortError refused kept products 200');
  const snap = (await bridge('window.__saywright.bridge.explore()')) as { url: string; blocked: string[] };
  expect(snap.blocked).toEqual([
    'a DELETE request to /api/users/7',
    'a POST request to /api/cart/clear-and-pay (“pay”)',
    '“OK” in a question it was asked (“Delete everything?”): it answered “Cancel”',
    'opening /logout (“logout”)',
    'sending a form: a POST request to /account/delete (“delete”)',
  ]);
  expect(snap.url).not.toContain('/logout');
  expect(sent).toEqual([]);
  // A person's own use of the app afterwards is never refused.
  page.once('dialog', (d) => void d.accept());
  await click('r3', false);
  await expect(frame.locator('#said')).toContainText('confirmed');
});
