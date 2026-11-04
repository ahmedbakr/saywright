/**
 * Write test's checks hold once the fix is in: a check is never found by the words the fix changes (a count in a
 * button's name, the value in a row, a word in a summary), a price or a count in a name is left open, a box said to
 * be checked is checked with toBeChecked, an option said to be chosen is looked for among the list's chosen ones, and
 * a link that is a picture is named by it. Each locator is run here by Playwright itself, before and after the "fix".
 * And a test changed after it failed proves nothing by passing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E_SHOP, expectIsland, openStudio, resetAll, store } from './helpers';

test.beforeEach(() => resetAll());

/** A part of the app's own code (the studio points at what it can find in the code): a like count, a price in a row, a summary. */
const FIXTURE = path.join(E2E_SHOP, 'src/components/Fixture.tsx');
test.afterEach(() => fs.rmSync(FIXTURE, { force: true }));

function writeFixture(like: number, pay: string, visit: string): void {
  fs.writeFileSync(
    FIXTURE,
    `export function Fixture() {
  return (
    <section className="fixture">
      <button type="button">Like this portfolio (${like})</button>
      <table>
        <tbody>
          <tr><th>You pay</th><td>${pay}</td></tr>
          <tr><th>Plan</th><td>Basic</td></tr>
        </tbody>
      </table>
      <dl><dt>Visit type</dt><dd>${visit}</dd><dt>Doctor</dt><dd>Dr. Amara Okafor</dd></dl>
    </section>
  );
}
`,
  );
}

/** The app shows the fixture above every page. */
function showFixture(): void {
  const app = path.join(E2E_SHOP, 'src/App.tsx');
  const code = fs.readFileSync(app, 'utf8');
  fs.writeFileSync(app, code.replace("import { Header } from './components/Header';", "import { Header } from './components/Header';\nimport { Fixture } from './components/Fixture';").replace('<Header route={route} />', '<Header route={route} />\n      <Fixture />'));
}

type Check = { locator: string; expected: string; actual: string; field?: string; description: string };

async function writeTestOnAccount(page: Page): Promise<void> {
  await openStudio(page);
  await page.frameLocator('iframe').locator('body').evaluate(() => (location.hash = '#/account'));
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Your account' })).toBeVisible();
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
}

/** A locator as the studio wrote it, found by Playwright in the app's frame. */
const resolve = (page: Page, code: string): Locator => new Function('page', `return ${code}`)(page.frameLocator('iframe')) as Locator;

/** Rest the mouse on an element of the app, then say what it should show (typed, as speech would come). */
async function say(page: Page, target: Locator, words: string): Promise<Check> {
  const before = await store<number>(page, 's.recorder.expectations.length');
  await target.scrollIntoViewIfNeeded();
  const b = await target.boundingBox();
  if (!b) throw new Error('not on screen');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.waitForTimeout(800);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill(words);
  await page.keyboard.press('Enter');
  await expectIsland(page, /Check added/);
  await expect.poll(() => store<number>(page, 's.recorder.expectations.length')).toBe(before + 1);
  return store<Check>(page, `s.recorder.expectations[${before}]`);
}

test('a check is found by what the fix doesn’t change, and still finds its element once the fix is in', async ({ page }) => {
  writeFixture(1, '$15.00', 'In person');
  showFixture();
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  await expect(app.getByRole('button', { name: 'Like this portfolio (1)' })).toBeVisible();

  // From the logo, flicked across in one go: the check is about where the mouse stopped, not what it passed over.
  const logo = await app.locator('a.logo').boundingBox();
  await page.mouse.move(logo!.x + 5, logo!.y + 5);
  const like = await say(page, app.getByRole('button', { name: 'Like this portfolio (1)' }), 'this should show Like this portfolio (2)');
  // The count is left open: not the name it has now, which the fix changes.
  expect(like.locator).toBe("page.getByRole('button', { name: /^Like this portfolio \\(\\d[\\d.,]*\\)$/ })");
  const pay = await say(page, app.getByRole('cell', { name: '$15.00' }), 'this should show $25.00');
  // By its row's heading.
  expect(pay.locator).toBe("page.getByRole('row').filter({ hasText: 'You pay' }).locator('td')");
  const visit = await say(page, app.getByText('In person', { exact: true }), 'this should show Video call');
  expect(visit.locator).not.toContain('In person');

  // Each finds one element now…
  for (const c of [like, pay, visit]) await expect(resolve(page, c.locator), c.locator).toHaveCount(1);
  // …and the same one once the fix makes it show what it should, where the check then passes.
  writeFixture(2, '$25.00', 'Video call');
  await expect(app.getByText('Video call')).toBeVisible();
  for (const c of [like, pay, visit]) {
    await expect(resolve(page, c.locator), c.locator).toHaveCount(1);
    await expect(resolve(page, c.locator), c.locator).toContainText(c.expected);
  }
});

test('a box said to be checked is checked, found from its label; an option said to be chosen, among the list’s chosen ones', async ({ page }) => {
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  const box = await say(page, app.getByText('Show password'), 'this should be checked');
  expect(box).toMatchObject({ field: 'checked', expected: 'checked', actual: 'not checked' });
  await expect(resolve(page, box.locator)).not.toBeChecked();
  await app.getByLabel('Show password').check();
  await expect(resolve(page, box.locator)).toBeChecked();
  const not = await say(page, app.getByText('Show password'), 'this shouldn’t be checked');
  expect(not).toMatchObject({ field: 'checked', expected: 'not checked', actual: 'checked' });

  const option = await say(page, app.getByRole('option', { name: 'Linen' }), 'this should be selected');
  expect(option).toMatchObject({ field: 'select', expected: 'Linen' });
  // The list, not the option: the test reads what is chosen in it.
  await expect(resolve(page, option.locator)).toHaveAttribute('id', 'interests');

  // The test written from them says so, in so many words.
  await page.evaluate(() => (window as unknown as { __saywright: { generateTest(): Promise<void> } }).__saywright.generateTest());
  await expect.poll(() => store<string | undefined>(page, 's.recorder.spec?.code')).toBeTruthy();
  const code = await store<string>(page, 's.recorder.spec.code');
  expect(code).toContain(`await expect(${box.locator}).toBeChecked();`);
  expect(code).toContain(`await expect(${not.locator}).not.toBeChecked();`);
  expect(code).toContain(`await expect(${option.locator}.locator('option:checked')).toContainText(['Linen']);`);
  expect(code).not.toContain("toContainText('checked')");
});

test('a link that is a picture is named by it, and a price in a button’s name is left open', async ({ page }) => {
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  await app.locator('body').evaluate(() => {
    const box = document.createElement('section');
    const img = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#963"/></svg>');
    box.innerHTML = `<a href="#/account"><img alt="A bag of Kenya AA" src="${img}" width="60" height="40"></a> <a href="#/account">Kenya AA</a>
      <button type="button">Pay $91.57 and subscribe</button>`;
    document.querySelector('main')!.prepend(box);
  });
  await app.getByRole('link', { name: 'Kenya AA', exact: true }).click();
  await app.getByRole('button', { name: 'Pay $91.57 and subscribe' }).click();
  await expect.poll(async () => (await store<{ kind: string }[]>(page, 's.recorder.steps')).filter((s) => s.kind === 'click').length).toBe(2);
  const [link, pay] = (await store<{ kind: string; locator: string }[]>(page, 's.recorder.steps')).filter((s) => s.kind === 'click');
  // Playwright counts the picture's link as “A bag of Kenya AA”: the text link is told apart from it.
  await expect(resolve(page, link.locator), link.locator).toHaveCount(1);
  await expect(resolve(page, link.locator)).toHaveText('Kenya AA');
  expect(pay.locator).not.toContain('91.57');
  await app.getByRole('button', { name: 'Pay $91.57 and subscribe' }).evaluate((b) => (b.textContent = 'Pay $89.10 and subscribe'));
  await expect(resolve(page, pay.locator), pay.locator).toHaveCount(1);
});

test('a test changed after it failed doesn’t pass as verified: the bug is still there', async ({ page }) => {
  test.setTimeout(150_000);
  await openStudio(page);
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  const app = page.frameLocator('iframe');
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await expect(app.getByTestId('summary-total')).toContainText('$78.40');
  await say(page, app.getByTestId('summary-total'), 'this should show $80.80');
  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  await page.getByRole('button', { name: 'Run it' }).click();
  await expectIsland(page, /Test failed: expected “\$80\.80”, got “\$78\.40”/);

  // Someone (or an AI asked for something else) makes the test expect what the bug shows.
  const spec = path.join(E2E_SHOP, await store<string>(page, 's.recorder.spec.path'));
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace("toContainText('$80.80')", "toContainText('$78.40')"));
  await page.evaluate(() => (window as unknown as { __saywright: { runTest(): Promise<void> } }).__saywright.runTest());
  await expectIsland(page, /Couldn’t verify\. The test changed since it failed/);
  // Said once: the next run judges the test as it is now.
  await page.evaluate(() => (window as unknown as { __saywright: { runTest(): Promise<void> } }).__saywright.runTest());
  await expectIsland(page, /Test passed in/);
});
