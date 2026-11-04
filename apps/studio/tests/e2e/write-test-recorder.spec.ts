/**
 * Write test records what was done as a test can do it again: a box ticked by its label once (and checked, not
 * clicked), a date picked as the date, typing before the suggestion clicked straight after it, and the keys that
 * choose from a combobox's list.
 */
import { expect, test, type Page } from '@playwright/test';
import { openStudio, resetAll, store } from './helpers';

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
