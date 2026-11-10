/**
 * Write test records what was done as a test can do it again: a box ticked by its label once (and checked, not
 * clicked), a date picked as the date, typing before the suggestion clicked straight after it, and the keys that
 * choose from a combobox's list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_SHOP, openStudio, resetAll, store } from './helpers';

test.beforeEach(() => resetAll());

async function writeTestOnAccount(page: Page): Promise<void> {
  await openStudio(page);
  await page.frameLocator('iframe').locator('body').evaluate(() => (location.hash = '#/account'));
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Your account' })).toBeVisible();
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
}

const steps = (page: Page) => store<{ kind: string; value?: string; checked?: boolean; key?: string; description: string }[]>(page, 's.recorder.steps');

/** A field that suggests as you type, as the WAI-ARIA pattern has it: a suggestion keeps the focus in the field. */
async function addCombobox(page: Page): Promise<void> {
  await page.frameLocator('iframe').locator('body').evaluate(() => {
    const box = document.createElement('div');
    box.innerHTML = `<label for="clinic">Clinic</label><input id="clinic" role="combobox" aria-autocomplete="list" aria-controls="clinics" aria-expanded="false" />
      <ul id="clinics" role="listbox" hidden><li role="option" id="harbor">Harbor View Medical Center</li></ul>`;
    document.querySelector('main')!.prepend(box);
    const input = box.querySelector('input')!;
    const list = box.querySelector('ul')!;
    input.addEventListener('input', () => (list.hidden = !input.value));
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', () => {
      input.value = 'Harbor View Medical Center';
      list.hidden = true;
    });
  });
}

test('a box ticked by clicking its label is one step, and the test checks it', async ({ page }) => {
  await writeTestOnAccount(page);
  await page.frameLocator('iframe').getByText('Show password').click();
  await expect.poll(async () => (await steps(page)).length).toBe(1);
  const [step] = await steps(page);
  expect(step).toMatchObject({ kind: 'fill', checked: true });
  expect(step.description).toMatch(/^Check .*Show password/);
});

test('a date picked is the step, as the date, with no click on the field', async ({ page }) => {
  await writeTestOnAccount(page);
  await page.frameLocator('iframe').locator('body').evaluate(() => {
    const field = document.createElement('label');
    field.innerHTML = 'Deliver on <input type="date" />';
    document.querySelector('main')!.prepend(field);
  });
  const date = page.frameLocator('iframe').getByLabel('Deliver on');
  await date.click();
  await date.fill('2026-11-20');
  await expect.poll(async () => (await steps(page)).map((s) => `${s.kind} ${s.value ?? ''}`.trim())).toEqual(['fill 2026-11-20']);
});

test('typing, then clicking a suggestion at once: the typing comes first', async ({ page }) => {
  await writeTestOnAccount(page);
  await addCombobox(page);
  const app = page.frameLocator('iframe');
  await app.getByRole('combobox', { name: 'Clinic' }).pressSequentially('harb', { delay: 20 });
  await app.getByRole('option', { name: 'Harbor View Medical Center' }).click();
  await expect.poll(async () => (await steps(page)).map((s) => `${s.kind}${s.value ? ` ${s.value}` : ''}`)).toEqual(['fill harb', 'click']);
});

test('the keys that choose from a combobox’s list are steps too', async ({ page }) => {
  await writeTestOnAccount(page);
  await addCombobox(page);
  const clinic = page.frameLocator('iframe').getByRole('combobox', { name: 'Clinic' });
  await clinic.pressSequentially('harb', { delay: 20 });
  await clinic.press('ArrowDown');
  await clinic.press('Enter');
  await expect.poll(async () => (await steps(page)).map((s) => `${s.kind} ${s.kind === 'press' ? s.key : s.value}`)).toEqual(['fill harb', 'press ArrowDown', 'press Enter']);
});

test('a reload keeps the test being written: its steps and checks are still there', async ({ page }) => {
  await writeTestOnAccount(page);
  await page.frameLocator('iframe').getByLabel('Email').fill('me@example.com');
  await page.frameLocator('iframe').getByText('Show password').click();
  await expect.poll(async () => (await steps(page)).length).toBe(2);
  const before = await steps(page);
  // Kept a moment after each change.
  await page.waitForTimeout(500);
  await page.reload();
  await expect.poll(() => store<boolean>(page, '!!s.status?.app')).toBe(true);
  await expect.poll(async () => (await steps(page)).map((s) => s.description)).toEqual(before.map((s) => s.description));
});

test('Start over on another page asks where the new test starts: here, or the app’s start page (signed out)', async ({ page }) => {
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  await app.getByLabel('Show password').check();
  await expect.poll(async () => (await steps(page)).length).toBeGreaterThan(0);
  const tab = page.locator('[role="tabpanel"]');
  await tab.getByRole('button', { name: 'Start over' }).click();
  await expect(tab.locator('[data-start-over]')).toContainText('this page (/#/account)');
  // From the start page: the app goes back there, and the test starts from it.
  await tab.getByRole('button', { name: 'From the start page' }).click();
  await expect(app.getByRole('heading', { name: 'Your account' })).toBeHidden();
  expect(await steps(page)).toEqual([]);
  expect(new URL(await store<string>(page, 's.recorder.startUrl')).hash).toBe('');
  // On the start page, Start over starts over there, without asking.
  await expect.poll(() => store<boolean>(page, 's.app.connected'), { timeout: 15_000 }).toBe(true);
  await app.getByTestId('coupon-input').fill('SAVE20');
  await expect.poll(async () => (await steps(page)).length).toBeGreaterThan(0);
  await tab.getByRole('button', { name: 'Start over' }).click();
  await expect(tab.locator('[data-start-over]')).toHaveCount(0);
  expect(await steps(page)).toEqual([]);
});

test('a space typed into a field inside a web component is typing, in an open or a closed shadow root', async ({ page }) => {
  await writeTestOnAccount(page);
  await page.frameLocator('iframe').locator('body').evaluate(() => {
    for (const mode of ['open', 'closed'] as const) {
      const host = document.createElement(`nick-${mode}`);
      const root = host.attachShadow({ mode });
      root.innerHTML = `<label>Nickname ${mode} <input /></label>`;
      document.querySelector('main')!.prepend(host);
      (window as unknown as Record<string, HTMLInputElement>)[`nick_${mode}`] = root.querySelector('input')!;
    }
  });
  const frame = page.frames().find((f) => f !== page.mainFrame())!;
  for (const mode of ['open', 'closed']) {
    await frame.evaluate((m) => (window as unknown as Record<string, HTMLInputElement>)[`nick_${m}`].focus(), mode);
    await page.keyboard.type('Ada Lovelace the First', { delay: 15 });
    expect(await frame.evaluate((m) => (window as unknown as Record<string, HTMLInputElement>)[`nick_${m}`].value, mode)).toBe('Ada Lovelace the First');
  }
  // Nothing started listening.
  expect(await store<string>(page, 's.voice.state')).toBe('idle');
  await expect.poll(async () => (await steps(page)).filter((s) => s.kind === 'fill').map((s) => s.value)).toContain('Ada Lovelace the First');
});

test('on full page loads the recording carries on from each page’s first moment, and waits for each new page', async ({ page }) => {
  // A three-page wizard of plain pages: each moves on by location.href; the second has an image that takes 6 s.
  const pages = [1, 2, 3].map((n) => path.join(E2E_SHOP, `wizard${n}.html`));
  pages.forEach((file, i) =>
    fs.writeFileSync(
      file,
      `<!doctype html><html><head><meta charset="utf-8"><title>Step ${i + 1}</title></head><body><main>
<h1>Step ${i + 1}</h1>${i === 1 ? '<img src="/slow.png" alt="" width="10" height="10">' : ''}
<label>Answer ${i + 1} <input id="a"></label> <button id="go">Continue</button>
<script>
document.getElementById('go').onclick = () => { sessionStorage.setItem('a${i + 1}', document.getElementById('a').value); setTimeout(() => (location.href = '/wizard${i + 2}.html'), 300); };
</script></main></body></html>`,
    ),
  );
  try {
    await page.route('**/slow.png', async (route) => {
      await new Promise((r) => setTimeout(r, 6000));
      await route.fulfill({ status: 404, body: '' });
    });
    await writeTestOnAccount(page);
    const app = page.frameLocator('iframe');
    await app.locator('body').evaluate(() => (location.href = '/wizard1.html'));
    for (const n of [1, 2]) {
      await expect(app.getByRole('heading', { name: `Step ${n}` })).toBeVisible();
      await page.waitForTimeout(300);
      await app.getByLabel(`Answer ${n}`).fill(n === 1 ? 'a' : 'b');
      await app.getByRole('button', { name: 'Continue' }).click();
    }
    await expect
      .poll(async () => (await steps(page)).map((s) => `${s.kind} ${s.kind === 'fill' ? s.value : s.kind === 'url' ? s.description : ''}`.trim()), { timeout: 4000 })
      .toEqual(['fill a', 'click', 'url Wait for /wizard2.html', 'fill b', 'click', 'url Wait for /wizard3.html']);
  } finally {
    for (const file of pages) fs.rmSync(file, { force: true });
  }
});
