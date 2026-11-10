/**
 * The report, used the way a person does: read in English or Arabic, set
 * findings aside, fix all the rest at once, pick suggestions to implement,
 * and correct a word the recogniser got wrong before rewriting the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { openStudio, resetAll, SHOP_URL, store, STUDIO } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
test.beforeEach(() => resetAll());

const post = async (route: string, body: unknown) => (await fetch(`${STUDIO}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

async function ready(id: string): Promise<void> {
  await expect.poll(async () => (await (await fetch(`${STUDIO}/api/sessions/${id}`)).json()).meta.status, { timeout: 60_000 }).toBe('ready');
}

/** A session with known problems, sent through the same API the app's recorder uses. */
async function sessionWithProblems(): Promise<string> {
  const { session } = await post('/sessions', { name: 'Checkout problems', appUrl: `${SHOP_URL}/`, source: 'studio', lang: 'en' });
  const t = session.startedAt as number;
  const pay = { src: 'src/components/OrderSummary.tsx:25:9', name: 'Button', tag: 'button', role: 'button', label: 'Pay $98.00', text: 'Pay $98.00', rect: [10, 10, 200, 40], locator: "page.getByRole('button', { name: 'Pay' })", description: 'the “Pay” button' };
  await post(`/sessions/${session.id}/events`, {
    page: 'p1',
    events: [
      { seq: 1, t: t + 100, type: 'page', url: `${SHOP_URL}/#/checkout`, title: 'Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false },
      { seq: 2, t: t + 1000, type: 'net', via: 'fetch', method: 'POST', url: '/api/coupon', status: 500, ok: false, ms: 120, body: 'boom' },
      { seq: 3, t: t + 2000, type: 'error', kind: 'error', message: 'Cannot read properties of undefined (reading total)', stack: `TypeError: x\n    at apply (${SHOP_URL}/src/lib/pricing.ts:32:11)` },
      { seq: 4, t: t + 3500, type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: pay },
      { seq: 5, t: t + 3500, type: 'dead', x: 1, y: 1, el: pay },
    ],
  });
  await post(`/sessions/${session.id}/stop`, {});
  await ready(session.id);
  return session.id;
}

async function openReport(page: Page, id: string): Promise<void> {
  await openStudio(page);
  await page.goto(`/report/${id}`);
  await expect(page.locator('[data-findings]')).toBeVisible();
}

const findingsCount = (page: Page) => page.locator('[data-findings] h2 .tabular').innerText();

test('a session with nothing technical wrong doesn’t claim it is ready to ship, and offers a check', async ({ page }) => {
  // The coupon bug: the total is wrong, but nothing errs, fails or stalls.
  const { session } = await post('/sessions', { name: 'Coupon at checkout', appUrl: `${SHOP_URL}/`, source: 'studio', lang: 'auto' });
  const t = session.startedAt as number;
  const field = { src: 'src/components/CouponField.tsx:44:7', name: 'TextField', tag: 'input', role: 'textbox', label: 'Coupon', text: '', rect: [10, 10, 200, 40], locator: "page.getByTestId('coupon-input')", description: 'the “Coupon” field' };
  const pay = { src: 'src/components/OrderSummary.tsx:25:9', name: 'Button', tag: 'button', role: 'button', label: 'Pay $78.40', text: 'Pay $78.40', rect: [10, 60, 200, 40], locator: "page.getByTestId('pay-button')", description: 'the “Pay” button' };
  await post(`/sessions/${session.id}/events`, {
    page: 'p1',
    events: [
      { seq: 1, t: t + 100, type: 'page', url: `${SHOP_URL}/#/checkout`, title: 'Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false },
      { seq: 2, t: t + 2000, type: 'input', el: field, value: 'SAVE20', masked: false },
      { seq: 3, t: t + 2500, type: 'key', key: 'Enter', mods: '', el: field },
      { seq: 4, t: t + 6000, type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: pay },
    ],
  });
  await post(`/sessions/${session.id}/stop`, {});
  await ready(session.id);
  await openReport(page, session.id);
  await expect(page.locator('[data-verdict-badge]')).toHaveText('No technical problems found');
  await expect(page.locator('[data-scope]')).toContainText('It can’t tell whether the values on screen are right.');
  await expect(page.getByText('Ready to ship')).toHaveCount(0);
  // No narration: no language in the header, nothing to transcribe again.
  const report = page.getByRole('dialog', { name: 'Session report' });
  await expect(report.getByRole('banner')).toContainText('Coupon at checkout');
  await expect(report.getByRole('banner')).not.toContainText('Arabic + English');
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: 'Rewrite the report' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Transcribe the narration again' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto(`/report/${session.id}`);
  // Add a check: back in the studio, recording, with the session's steps to build the test on.
  await page.locator('[data-add-check]').click();
  await expect(page.locator('[data-findings]')).toHaveCount(0);
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  expect(await store<string[]>(page, 's.recorder.steps.map((x) => x.kind)')).toEqual(['fill', 'press', 'click']);
});

test('set a finding aside, and bring it back; it stays aside after a reload', async ({ page }) => {
  const id = await sessionWithProblems();
  await openReport(page, id);
  expect(await findingsCount(page)).toBe('3');
  const first = await page.locator('[data-findings] article h3').first().innerText();
  await page.locator('[data-findings] [data-skip]').first().click();
  await expect.poll(() => findingsCount(page)).toBe('2');
  await expect(page.locator('[data-skipped]')).toContainText('Skipped (1)');
  await page.reload();
  await expect.poll(() => findingsCount(page)).toBe('2');
  await page.locator('[data-skipped] button').first().click();
  await expect(page.locator('[data-skipped]')).toContainText(first);
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect.poll(() => findingsCount(page)).toBe('3');
  await expect(page.locator('[data-skipped]')).toHaveCount(0);
});

test('fix all sends every finding not set aside to Claude, in one request', async ({ page }) => {
  const id = await sessionWithProblems();
  await openReport(page, id);
  const titles = await page.locator('[data-findings] article h3').allInnerTexts();
  await page.locator('[data-findings] [data-skip]').first().click();
  await expect.poll(() => findingsCount(page)).toBe('2');
  const request = page.waitForRequest((r) => r.url().endsWith('/api/intent') && r.method() === 'POST');
  await page.locator('[data-fix-all]').click();
  const body = JSON.parse((await request).postData() ?? '{}') as { text: string; brief: string };
  expect(body.text).toBe('Fix these 2 problems found in a test session.');
  expect(body.brief).toContain(titles[1]);
  expect(body.brief).toContain(titles[2]);
  expect(body.brief).not.toContain(titles[0]);
  // Back in the studio, with Claude's change to keep or undo.
  await expect(page.locator('[data-findings]')).toHaveCount(0);
});

test('pick suggestions and Claude implements them together', async ({ page }) => {
  const id = await sessionWithProblems();
  await openReport(page, id);
  const cards = page.locator('[data-suggestions] label');
  await expect(page.locator('[data-implement]')).toBeDisabled();
  await cards.nth(0).click();
  await cards.nth(2).click();
  await expect(page.locator('[data-implement]')).toHaveText(/Implement selected \(2\)/);
  const picked = [await cards.nth(0).locator('span span').first().innerText(), await cards.nth(2).locator('span span').first().innerText()];
  const request = page.waitForRequest((r) => r.url().endsWith('/api/intent') && r.method() === 'POST');
  await page.locator('[data-implement]').click();
  const body = JSON.parse((await request).postData() ?? '{}') as { text: string; brief: string };
  expect(body.text).toBe('Implement these 2 suggestions from a test session report.');
  for (const p of picked) expect(body.brief).toContain(p);
});

test('the report reads in Arabic or English, exported and copied in the language shown', async ({ page }) => {
  const id = await sessionWithProblems();
  await openReport(page, id);
  await page.getByRole('radio', { name: 'العربية' }).click();
  await expect(page.locator('[data-report-lang="ar"]')).toBeVisible();
  await expect(page.locator('[dir="rtl"]').first()).toBeVisible();
  await expect(page.locator('[data-findings] h2')).toContainText('الملاحظات');
  await expect(page.locator('[data-findings] article h3').first()).toContainText(/[؀-ۿ]/);
  // The timeline describes what happened in Arabic too.
  await expect(page.locator('[data-tl]', { hasText: /نقر على زر «\u2068Pay \$98\.00\u2069»/ }).first()).toBeVisible();
  // The choice is remembered.
  await page.reload();
  await expect(page.locator('[data-findings] h2')).toContainText('الملاحظات');
  const html = await (await fetch(`${STUDIO}/api/sessions/${id}/export.html?lang=ar`)).text();
  expect(html).toContain('dir="rtl"');
  expect(html).toMatch(/[؀-ۿ]{4,}/);
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.locator('[data-findings] h2')).toContainText('Findings');
});

test('correct a word in the transcript, then rewrite the report with it', async ({ page }) => {
  test.setTimeout(150_000);
  const status = (await (await fetch(`${STUDIO}/api/speech/status`)).json()) as { runtime: string; active: Record<string, string | null> };
  test.skip(status.runtime === 'missing' || status.runtime === 'failed' || !status.active.en, 'No English speech model here');
  // A real recording as the narration, sent the way the recorder sends it: half a second at a time.
  const { session } = await post('/sessions', { name: 'Narrated', appUrl: `${SHOP_URL}/`, source: 'studio', lang: 'en' });
  await post(`/sessions/${session.id}/events`, { page: 'p1', events: [{ seq: 1, t: session.startedAt + 50, type: 'page', url: `${SHOP_URL}/#/checkout`, title: 'Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false }] });
  const pcm = fs.readFileSync(path.join(here, '../fixtures/speech/en-fleurs-smoke.wav')).subarray(44);
  const quiet = Buffer.alloc(16000 * 2 * 2);
  const audio = Buffer.concat([quiet, pcm, quiet]);
  for (let at = 0; at < audio.length; at += 16000) {
    await fetch(`${STUDIO}/api/sessions/${session.id}/audio?t=${session.startedAt + 500 + at / 32}`, { method: 'POST', body: audio.subarray(at, at + 16000), headers: { 'Content-Type': 'text/plain' } });
  }
  await post(`/sessions/${session.id}/stop`, {});
  await ready(session.id);

  await openReport(page, session.id);
  await page.getByRole('tab', { name: /Transcript/ }).click();
  const sentence = page.locator('[data-transcript] [data-seg]').first();
  await expect(sentence).toContainText(/smoke/i);
  await sentence.getByTitle('Correct').click();
  const box = sentence.getByRole('textbox');
  const heard = await box.inputValue();
  await box.fill(heard.replace(/smoke/i, 'smoke and steam'));
  await box.press('Enter');
  await expect(sentence.locator('[data-corrected]')).toBeVisible();
  await expect(sentence).toContainText('smoke and steam');
  await expect(page.locator('[data-rewrite]')).toContainText('1 corrected sentence isn’t in this report yet.');
  await page.locator('[data-rewrite]').getByRole('button', { name: 'Rewrite the report' }).click();
  await expect(page.locator('[data-rewrite]')).toHaveCount(0, { timeout: 60_000 });
  // The rewritten report reads the corrected words, and keeps what was heard.
  const d = (await (await fetch(`${STUDIO}/api/sessions/${session.id}`)).json()) as { analysis: { transcript: { text: string; original?: string }[] } };
  expect(d.analysis.transcript[0].text).toContain('smoke and steam');
  expect(d.analysis.transcript[0].original).toBe(heard);
});

test('a request still waiting when the session stops is in the report; an empty session has nothing to judge, and no score', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
  // Never answered.
  await page.route('**/api/hang', () => undefined);
  await openStudio(page);
  const frame = page.frames().find((f) => f.url().startsWith(SHOP_URL))!;
  const record = async (name: string, during: () => Promise<void>) => {
    await page.getByRole('button', { name: 'Record session', exact: true }).click();
    await page.getByPlaceholder('What are you testing? (optional)').fill(name);
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await during();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    let id = '';
    await expect
      .poll(async () => {
        const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string; name: string; status: string }[] };
        id = sessions.find((s) => s.name === name)?.id ?? '';
        return sessions.find((s) => s.id === id)?.status;
      }, { timeout: 60_000 })
      .toBe('ready');
    return id;
  };
  const hung = await record('Export CSV', async () => {
    await frame.evaluate(() => {
      const b = document.createElement('button');
      b.textContent = 'Export CSV';
      b.onclick = () => void fetch('/api/hang');
      document.body.prepend(b);
    });
    await frame.getByRole('button', { name: 'Export CSV' }).click();
    await page.waitForTimeout(4000);
  });
  const d = (await (await fetch(`${STUDIO}/api/sessions/${hung}`)).json()) as { analysis: { issues: { title: string }[] } };
  expect(d.analysis.issues.map((i) => i.title)).toContain('GET /api/hang never answered');
  await page.keyboard.press('Escape');

  const empty = await record('Empty', async () => undefined);
  await page.goto(`/report/${empty}`);
  await expect(page.locator('[data-nothing-to-judge]')).toContainText('Nothing to judge yet');
  await expect(page.getByText('No technical problems found')).toHaveCount(0);
});

test('quick clicks that each change something, drawing on a canvas, a download and an HTML fragment asked for are no problems', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
  await page.route('**/frag/cart', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<ul><li>Linen napkins × 1</li></ul>' }));
  await openStudio(page);
  const frame = page.frames().find((f) => f.url().startsWith(SHOP_URL))!;
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Clean use');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await frame.evaluate(() => {
    const box = document.createElement('div');
    box.innerHTML = `<button id="plus" aria-label="Increase quantity">+</button> Qty <span id="qty">1</span>
      <button id="view">View cart</button><div id="cart"></div>
      <canvas id="pad" width="200" height="80" style="cursor:crosshair"></canvas>
      <button id="invoice">Download invoice</button>`;
    document.body.prepend(box);
    document.getElementById('plus')!.onclick = () => (document.getElementById('qty')!.textContent = String(Number(document.getElementById('qty')!.textContent) + 1));
    document.getElementById('view')!.onclick = async () => (document.getElementById('cart')!.innerHTML = await (await fetch('/frag/cart')).text());
    const pad = document.getElementById('pad') as HTMLCanvasElement;
    pad.onclick = (e) => pad.getContext('2d')!.fillRect(e.offsetX, e.offsetY, 4, 4);
    document.getElementById('invoice')!.onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['invoice'], { type: 'text/plain' }));
      a.download = 'invoice.txt';
      a.click();
    };
  });
  await frame.locator('#view').click();
  for (let i = 0; i < 4; i++) await frame.locator('#plus').click();
  await frame.locator('#pad').click({ position: { x: 20, y: 20 } });
  await frame.locator('#invoice').click();
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  let id = '';
  await expect
    .poll(async () => {
      const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string; name: string; status: string }[] };
      id = sessions.find((s) => s.name === 'Clean use')?.id ?? '';
      return sessions.find((s) => s.id === id)?.status;
    }, { timeout: 60_000 })
    .toBe('ready');
  const d = (await (await fetch(`${STUDIO}/api/sessions/${id}`)).json()) as { analysis: { issues: { kind: string; title: string }[] } };
  expect(d.analysis.issues.filter((i) => i.kind === 'network' || i.kind === 'frustration').map((i) => i.title)).toEqual([]);
});
