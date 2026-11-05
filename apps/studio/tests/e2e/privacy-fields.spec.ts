/**
 * What is typed into a rich text editor marked private (itself, or a part of the page it is in), or into a secret
 * field inside a shadow root, never leaves the page: not in Write test's steps or the test written from them, not in
 * a session's data. And while a session records, its pictures show such fields masked, inside shadow roots too (one
 * added later, one inside another), with nothing left behind once the session ends.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import type { RecordedStep } from '../../shared/api';
import { openStudio, resetAll, store, STUDIO } from './helpers';

/** Made up for the test: what must never show up anywhere. */
const SECRET = 'Synthetic-Private-Value-42';

test.beforeEach(async ({ page }) => {
  await resetAll();
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
});

/** In the app's page: an editor marked private, one inside a part marked private, and an API key field in a shadow root. */
async function addFields(app: FrameLocator): Promise<void> {
  await app.locator('body').evaluate(() => {
    const box = document.createElement('section');
    box.innerHTML = `<div contenteditable="true" data-private data-testid="private-editor" aria-label="Private notes" style="min-height:24px;border:1px solid #999"></div>
      <section data-private><div contenteditable="true" data-testid="editor-in-private" aria-label="Delivery notes" style="min-height:24px;border:1px solid #999"></div></section>
      <div id="key-host"></div>`;
    document.querySelector('main')!.prepend(box);
    document.getElementById('key-host')!.attachShadow({ mode: 'open' }).innerHTML = '<label>API key <input data-testid="shadow-key"></label>';
  });
}

async function typeEach(page: Page, app: FrameLocator): Promise<void> {
  for (const id of ['private-editor', 'editor-in-private', 'shadow-key']) {
    await app.getByTestId(id).click();
    await page.keyboard.type(SECRET, { delay: 5 });
  }
  await page.keyboard.press('Tab');
}

const masked = (app: FrameLocator, id: string) =>
  app.getByTestId(id).evaluate((el) => ({ marked: el.hasAttribute('data-saywright-masked'), dots: getComputedStyle(el).getPropertyValue('-webkit-text-security') === 'disc', blurred: getComputedStyle(el).filter.includes('blur') }));

test('Write test records what is typed into private editors and a shadow root’s key field by name only, and the test holds no secret', async ({ page }) => {
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await addFields(app);
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  await typeEach(page, app);
  await expect.poll(() => store<number>(page, 's.recorder.steps.length')).toBe(3);
  const steps = await store<RecordedStep[]>(page, 's.recorder.steps');
  expect(steps.map((s) => ({ locator: s.locator, value: s.value, secret: s.secret }))).toEqual([
    { locator: "page.getByTestId('private-editor')", value: '', secret: 'PRIVATE_NOTES' },
    { locator: "page.getByTestId('editor-in-private')", value: '', secret: 'DELIVERY_NOTES' },
    { locator: "page.getByTestId('shadow-key')", value: '', secret: 'API_KEY' },
  ]);
  expect(JSON.stringify(steps)).not.toContain(SECRET);
  // What the studio shows of the editor is never its text either.
  expect(JSON.stringify(await store(page, 's.hover'))).not.toContain(SECRET);
  const res = await fetch(`${STUDIO}/api/tests/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startUrl: '/', steps, expectations: [{ locator: "page.getByTestId('summary-total')", description: 'the total', expected: '$78.40', actual: '$78.40' }] }),
  });
  const { code } = (await res.json()) as { code: string };
  expect(code).toContain("await page.getByTestId('private-editor').fill(secret('PRIVATE_NOTES'));");
  expect(code).toContain("await page.getByTestId('shadow-key').fill(secret('API_KEY'));");
  expect(code).not.toContain(SECRET);
});

test('a session masks them in its pictures, in shadow roots too (added later, and inside another), and leaves nothing behind', async ({ page }) => {
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await addFields(app);
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Private fields');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await typeEach(page, app);
  // A root attached after its host was added, and a root inside it, each with a secret field.
  await app.locator('body').evaluate(() => {
    const host = document.createElement('div');
    document.querySelector('main')!.prepend(host);
    setTimeout(() => {
      const outer = host.attachShadow({ mode: 'open' });
      outer.innerHTML = '<label>Password <input type="text" data-testid="late-password"></label><div id="inner"></div>';
      (outer.getElementById('inner') as HTMLElement).attachShadow({ mode: 'open' }).innerHTML = '<label>Card number <input data-testid="nested-card"></label>';
    }, 200);
  });
  await expect.poll(() => masked(app, 'shadow-key')).toEqual({ marked: true, dots: true, blurred: false });
  for (const id of ['private-editor', 'editor-in-private']) await expect.poll(() => masked(app, id).then((m) => m.blurred), { message: id }).toBe(true);
  await expect.poll(() => masked(app, 'late-password').then((m) => m.dots), { timeout: 5000 }).toBe(true);
  await expect.poll(() => masked(app, 'nested-card').then((m) => m.dots), { timeout: 5000 }).toBe(true);
  // The session's text (what the screen said) has the editors' words left out.
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  // Nothing of the mask stays: in the page, or in any shadow root.
  await expect
    .poll(() =>
      app.locator('body').evaluate(() => {
        const roots: ShadowRoot[] = [];
        const walk = (n: Node) => {
          const w = document.createTreeWalker(n, NodeFilter.SHOW_ELEMENT);
          for (let el = w.nextNode() as Element | null; el; el = w.nextNode() as Element | null) {
            if (!el.shadowRoot) continue;
            roots.push(el.shadowRoot);
            walk(el.shadowRoot);
          }
        };
        walk(document);
        return {
          pageStyle: !!document.getElementById('saywright-mask'),
          marked: document.querySelectorAll('[data-saywright-masked]').length + roots.reduce((n, r) => n + r.querySelectorAll('[data-saywright-masked]').length, 0),
          rootStyles: roots.reduce((n, r) => n + r.querySelectorAll('style[data-saywright-mask]').length, 0),
        };
      }),
    )
    .toEqual({ pageStyle: false, marked: 0, rootStyles: 0 });
  // And none of it is anywhere in what the session kept.
  let id = '';
  await expect
    .poll(async () => {
      const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string; name: string; status: string }[] };
      const s = sessions.find((x) => x.name === 'Private fields');
      id = s?.id ?? '';
      return s?.status;
    }, { timeout: 60_000 })
    .toBe('ready');
  const detail = await (await fetch(`${STUDIO}/api/sessions/${id}`)).text();
  expect(detail).not.toContain(SECRET);
  const events = await (await fetch(`${STUDIO}/api/sessions/${id}/events`)).text().catch(() => '');
  expect(events).not.toContain(SECRET);
});
