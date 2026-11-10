/**
 * Write test records every kind of field a person uses, and plays each back right: an option of a list that says the
 * same as another (“Standard” twice) is chosen by its value, what is typed into a rich text editor (contenteditable)
 * and into a field inside an open shadow root is kept, and the test written from them passes, verified.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RecordedStep } from '../../shared/api';
import { E2E_SHOP, expectIsland, openStudio, resetAll, runToEnd, store } from './helpers';

test.beforeEach(() => resetAll());

const FIXTURE = path.join(E2E_SHOP, 'src/components/Fixture.tsx');
test.afterEach(() => fs.rmSync(FIXTURE, { force: true }));

/** Above every page: a list with two options that say the same, a rich text editor, and a field in a shadow root. */
function showFixture(): void {
  fs.writeFileSync(
    FIXTURE,
    `import { useEffect, useRef, useState } from 'react';

export function Fixture() {
  const [shipping, setShipping] = useState('std-eu');
  const [notes, setNotes] = useState('');
  const [promo, setPromo] = useState('');
  const [guests, setGuests] = useState('2');
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || el.shadowRoot) return;
    const root = el.attachShadow({ mode: 'open' });
    root.innerHTML = '<label>Promo code <input data-testid="promo"></label>';
    root.querySelector('input')!.addEventListener('input', (e) => setPromo((e.target as HTMLInputElement).value));
  }, []);
  return (
    <section className="fixture">
      <label>
        Shipping
        <select value={shipping} onChange={(e) => setShipping(e.target.value)}>
          <option value="std-eu">Standard</option>
          <option value="std-us">Standard</option>
          <option value="fast">Express</option>
        </select>
      </label>
      <output data-testid="shipping-chosen">{shipping}</output>
      <label>
        <span data-testid="name-caption">Full name</span> <input />
      </label>
      <label>
        Guests <input type="number" value={guests} onChange={(e) => setGuests(e.target.value)} />
      </label>
      <div role="textbox" aria-label="Delivery notes" contentEditable suppressContentEditableWarning data-testid="notes" style={{ minHeight: 24, border: '1px solid #999' }} onInput={(e) => setNotes(e.currentTarget.innerText)} />
      <output data-testid="notes-said">{notes}</output>
      <div ref={host} data-testid="promo-host" />
      <output data-testid="promo-said">{promo}</output>
    </section>
  );
}
`,
  );
  const app = path.join(E2E_SHOP, 'src/App.tsx');
  const code = fs.readFileSync(app, 'utf8');
  fs.writeFileSync(app, code.replace("import { Header } from './components/Header';", "import { Header } from './components/Header';\nimport { Fixture } from './components/Fixture';").replace('<Header route={route} />', '<Header route={route} />\n      <Fixture />'));
}

/** Rest the mouse on an element of the app, then say what it should show (typed, as speech would come). */
async function say(page: Page, target: Locator, words: string): Promise<void> {
  const before = await store<number>(page, 's.recorder.expectations.length');
  const b = await target.boundingBox();
  if (!b) throw new Error('not on screen');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.waitForTimeout(800);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill(words);
  await page.keyboard.press('Enter');
  await expectIsland(page, /Check added/);
  await expect.poll(() => store<number>(page, 's.recorder.expectations.length')).toBe(before + 1);
}

/** Play one step in the app the way the studio's replay does. */
const replay = (page: Page, locator: string, step: Record<string, unknown>) =>
  page.evaluate(([l, s]) => (window as unknown as { __saywright: { bridge: { replay: (...a: unknown[]) => Promise<{ ok: boolean; error?: string }> } } }).__saywright.bridge.replay(l, s), [locator, step] as const);

test('an option that says the same as another, a rich text editor and a field in a shadow root are recorded, written and played back', async ({ page }) => {
  test.setTimeout(180_000);
  showFixture();
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('shipping-chosen')).toHaveText('std-eu');
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');

  // The second “Standard”, typing into the editor, then into the field in the shadow root.
  await app.getByLabel('Shipping').selectOption({ value: 'std-us' });
  await app.getByTestId('notes').click();
  await page.keyboard.type('Leave at the door', { delay: 15 });
  await app.getByTestId('promo').click();
  await page.keyboard.type('SPRING', { delay: 15 });
  await page.keyboard.press('Tab');
  await expect(app.getByTestId('promo-said')).toHaveText('SPRING');
  await expect.poll(() => store<number>(page, 's.recorder.steps.length')).toBe(3);
  const steps = await store<RecordedStep[]>(page, 's.recorder.steps');
  expect(steps.map((s) => ({ kind: s.kind, locator: s.locator, value: s.value, byValue: s.byValue }))).toEqual([
    { kind: 'fill', locator: "page.getByRole('combobox', { name: 'Shipping' })", value: 'std-us', byValue: true },
    { kind: 'fill', locator: "page.getByTestId('notes')", value: 'Leave at the door', byValue: undefined },
    { kind: 'fill', locator: "page.getByTestId('promo')", value: 'SPRING', byValue: undefined },
  ]);

  await say(page, app.getByTestId('shipping-chosen'), 'this should show std-us');
  await say(page, app.getByTestId('notes-said'), 'this should show Leave at the door');
  await say(page, app.getByTestId('promo-said'), 'this should show SPRING');
  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  const spec = fs.readFileSync(path.join(E2E_SHOP, await store<string>(page, 's.recorder.spec.path')), 'utf8');
  expect(spec).toContain("await page.getByRole('combobox', { name: 'Shipping' }).selectOption({ value: 'std-us' });");
  expect(spec).toContain("await page.getByTestId('notes').fill('Leave at the door');");
  expect(spec).toContain("await page.getByTestId('promo').fill('SPRING');");
  // Played by Playwright from a fresh browser: every step and check holds.
  await runToEnd(page, () => page.getByRole('button', { name: 'Run it' }).click());
  await expectIsland(page, /Test passed in [\d.]+ s: all 4 steps and 3 checks ran/);

  // And by the studio's own replay, in the page.
  await app.getByLabel('Shipping').selectOption({ value: 'fast' });
  expect(await replay(page, steps[0].locator!, { kind: 'fill', value: 'std-us', select: steps[0].select, values: steps[0].values, byValue: true })).toMatchObject({ ok: true });
  await expect(app.getByTestId('shipping-chosen')).toHaveText('std-us');
  expect(await replay(page, "page.getByTestId('notes')", { kind: 'fill', value: 'Ring twice' })).toMatchObject({ ok: true });
  await expect(app.getByTestId('notes-said')).toHaveText('Ring twice');
  expect(await replay(page, "page.getByTestId('promo')", { kind: 'fill', value: 'AUTUMN' })).toMatchObject({ ok: true });
  await expect(app.getByTestId('promo-said')).toHaveText('AUTUMN');
});

test('a check on a field in its label reads the field: what it holds, the option chosen, never the label’s words', async ({ page }) => {
  test.setTimeout(180_000);
  showFixture();
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await expect(app.getByTestId('shipping-chosen')).toHaveText('std-eu');
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  await app.getByLabel('Shipping').selectOption({ value: 'fast' });
  await app.getByLabel('Full name').fill('Ada Lovelace');
  await app.getByLabel('Guests').fill('15');
  await expect.poll(() => store<number>(page, 's.recorder.steps.length')).toBe(3);

  // On the list itself, on the label's words of a field, and on a number field: each reads the field.
  await say(page, app.getByLabel('Shipping'), 'this should show Express');
  await say(page, app.getByTestId('name-caption'), 'this should show Ada Lovelace');
  await say(page, app.getByLabel('Guests'), 'this should show 15');
  const checks = await store<{ locator: string; expected: string; actual: string; field?: string }[]>(page, 's.recorder.expectations');
  expect(checks.map((c) => ({ locator: c.locator, actual: c.actual, field: c.field }))).toEqual([
    { locator: "page.getByRole('combobox', { name: 'Shipping' })", actual: 'Express', field: 'select' },
    { locator: "page.getByRole('textbox', { name: 'Full name' })", actual: 'Ada Lovelace', field: 'value' },
    { locator: "page.getByLabel('Guests')", actual: '15', field: 'value' },
  ]);
  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  const spec = fs.readFileSync(path.join(E2E_SHOP, await store<string>(page, 's.recorder.spec.path')), 'utf8');
  expect(spec).not.toContain("locator('label')");
  expect(spec).toContain("await expect(page.getByRole('textbox', { name: 'Full name' })).toHaveValue('Ada Lovelace');");
  expect(spec).toContain("await expect(page.getByLabel('Guests')).toHaveValue('15');");
  await runToEnd(page, () => page.getByRole('button', { name: 'Run it' }).click());
  await expectIsland(page, /Test passed in [\d.]+ s: all 4 steps and 3 checks ran/);
});
