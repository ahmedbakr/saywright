/**
 * Write test records what was done as a test can do it again: a box ticked by its label once (and checked, not
 * clicked), a date picked as the date, typing before the suggestion clicked straight after it, and the keys that
 * choose from a combobox's list.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_SHOP, expectIsland, openStudio, resetAll, store, STUDIO } from './helpers';

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

test('a click in a page’s first moments is a step: the recording carries on as soon as the studio’s script has run there', async ({ page }) => {
  const file = path.join(E2E_SHOP, 'quick.html');
  fs.writeFileSync(file, '<!doctype html><html><head><meta charset="utf-8"><title>Quick</title></head><body><main><h1>Quick</h1><button>Go now</button></main></body></html>');
  await page.addInitScript(() => {
    if (window.parent === window) {
      // The studio, once the test says so: busy with work of its own for two seconds from the moment the next page
      // says it is here (as it is when it listens or tracks a hand). Until then it can't greet that page, or tell it
      // to record.
      window.addEventListener(
        'message',
        (e) => {
          const studio = window as { __busyAtNextPage?: boolean };
          if (!studio.__busyAtNextPage || (e.data as { type?: string } | null)?.type !== 'here') return;
          studio.__busyAtNextPage = false;
          const t = performance.now();
          while (performance.now() - t < 2000);
        },
        true,
      );
    } else if (location.pathname === '/quick.html') {
      // The new page: its button is clicked from inside it as soon as its scripts have run, the studio's among them.
      // (Not by the browser: in a frame's first moments the Chromium of GitHub's machines gives one click in six to
      // the page around the frame, and the app never has it.)
      let greeted = false;
      window.addEventListener('message', (e) => (greeted ||= (e.data as { type?: string } | null)?.type === 'hello'), true);
      document.addEventListener('DOMContentLoaded', () => {
        (window as { __clickedBeforeGreeted?: boolean }).__clickedBeforeGreeted = !greeted;
        document.querySelector('button')?.click();
      });
    }
  });
  try {
    await writeTestOnAccount(page);
    const app = page.frameLocator('iframe');
    // A first step: the page has heard the studio and is recording.
    await app.getByText('Show password').click();
    await expect.poll(async () => (await steps(page)).length).toBe(1);
    await page.evaluate(() => ((window as { __busyAtNextPage?: boolean }).__busyAtNextPage = true));
    await app.locator('body').evaluate(() => (location.href = '/quick.html'));
    await expect.poll(async () => (await steps(page)).slice(1).map((s) => s.description)).toEqual(['Wait for /quick.html', 'Click the “Go now” button']);
    // The step is the page's own doing: the studio hadn't greeted it when the click was made.
    expect(await app.locator('body').evaluate(() => (window as { __clickedBeforeGreeted?: boolean }).__clickedBeforeGreeted)).toBe(true);

    // Write test off: the tab no longer says to record, and the next page records nothing until the studio says so.
    await page.evaluate(() => (window as unknown as { __saywright: { setMode(mode: string): void } }).__saywright.setMode('use'));
    await expect.poll(() => app.locator('body').evaluate(() => sessionStorage.getItem('saywright.record'))).toBeNull();
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a confirm and a prompt answered while recording are kept with their steps; outside recording the app’s dialogs are its own', async ({ page }) => {
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  await app.locator('body').evaluate(() => {
    const box = document.createElement('div');
    box.innerHTML = '<button id="del">Delete account</button> <button id="ren">Rename</button> <p id="said">?</p>';
    document.querySelector('main')!.prepend(box);
    const said = box.querySelector('#said')!;
    box.querySelector('#del')!.addEventListener('click', () => (said.textContent = confirm('Really delete?') ? 'Account: deleted' : 'Kept'));
    box.querySelector('#ren')!.addEventListener('click', () => (said.textContent = `Project: ${prompt('New name?')}`));
  });
  page.once('dialog', (d) => d.accept());
  await app.getByRole('button', { name: 'Delete account' }).click();
  await expect(app.locator('#said')).toHaveText('Account: deleted');
  page.once('dialog', (d) => d.accept('Zephyr'));
  await app.getByRole('button', { name: 'Rename' }).click();
  await expect(app.locator('#said')).toHaveText('Project: Zephyr');
  await expect
    .poll(async () => (await store<{ dialogs?: unknown[] }[]>(page, 's.recorder.steps')).map((s) => s.dialogs))
    .toEqual([[{ type: 'confirm', accept: true, message: 'Really delete?' }], [{ type: 'prompt', accept: true, text: 'Zephyr', message: 'New name?' }]]);
  await expect(page.getByText('Answered “Zephyr”')).toBeVisible();
  // Recording stopped: the page's own confirm again.
  await page.evaluate(() => (window as any).__saywright.setMode('use'));
  await expect.poll(() => store<string>(page, 's.mode')).toBe('use');
  expect(await app.locator('body').evaluate(() => String(window.confirm))).toContain('[native code]');
});

test('what Playwright can do again is recorded as it does it, and what it can’t is said in the steps', async ({ page }) => {
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  await app.locator('body').evaluate(() => {
    const box = document.createElement('div');
    box.innerHTML = `<style>.menu .sub { display: none } .menu:hover .sub { display: block } #js-sub { display: none }</style>
      <button id="like">Super like</button> <button id="file-menu">Report.pdf</button>
      <textarea aria-label="Message"></textarea>
      <label>Invoice <input type="file" id="invoice"></label>
      <ul id="order"><li draggable="true">Alpha</li><li draggable="true">Bravo</li><li draggable="true">Charlie</li></ul>
      <div class="menu"><span>Products</span><div class="sub"><button>Laptops</button></div></div>
      <div id="js-menu"><span>Account menu</span><div id="js-sub"><button>Sign out everywhere</button></div></div>
      <iframe srcdoc="<button>Inside</button>" title="Pay" style="width:200px;height:60px"></iframe>
      <p id="log">Nothing yet</p>`;
    document.querySelector('main')!.prepend(box);
    const log = box.querySelector('#log')!;
    box.querySelector('#like')!.addEventListener('dblclick', () => (log.textContent = 'Super like'));
    box.querySelector('#file-menu')!.addEventListener('contextmenu', (e) => e.preventDefault());
    // A list ordered by drag and drop, as apps do it: the drop target takes the drag over it.
    const order = box.querySelector('#order')!;
    let dragged: Element | null = null;
    order.addEventListener('dragstart', (e) => (dragged = e.target as Element));
    order.addEventListener('dragover', (e) => e.preventDefault());
    order.addEventListener('drop', (e) => {
      e.preventDefault();
      order.insertBefore(dragged!, (e.target as Element).closest('li'));
    });
    const menu = box.querySelector('#js-menu')!;
    menu.addEventListener('mouseenter', () => ((box.querySelector('#js-sub') as HTMLElement).style.display = 'block'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'n' && !(e.target instanceof HTMLTextAreaElement)) log.textContent = 'New note';
    });
  });
  await app.getByRole('button', { name: 'Super like' }).dblclick();
  await app.getByRole('button', { name: 'Report.pdf' }).click({ button: 'right' });
  await app.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('n');
  await page.keyboard.press('Control+k');
  await app.getByRole('textbox', { name: 'Message' }).pressSequentially('Hello', { delay: 10 });
  await page.keyboard.press('Shift+Enter');
  await app.getByLabel('Invoice').setInputFiles({ name: 'march.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') });
  await app.getByText('Charlie').dragTo(app.getByText('Alpha'));
  await app.getByText('Products').hover();
  await app.getByRole('button', { name: 'Laptops' }).click();
  await app.getByText('Account menu').hover();
  await app.getByRole('button', { name: 'Sign out everywhere' }).click();
  await app.frameLocator('iframe[title="Pay"]').getByRole('button', { name: 'Inside' }).click();
  await expect
    .poll(async () => (await store<{ kind: string; key?: string; count?: number; button?: string; description: string }[]>(page, 's.recorder.steps')).map((s) => `${s.kind}${s.count ? ' ×2' : ''}${s.button ? ` ${s.button}` : ''}${s.key ? ` ${s.key}` : ''}: ${s.description}`))
    .toEqual([
      expect.stringMatching(/^click ×2: Double-click .*Super like/),
      expect.stringMatching(/^click right: Right-click .*Report\.pdf/),
      expect.stringMatching(/^click: Click /),
      'press n: Press n',
      'press Control+k: Press Control+k',
      expect.stringMatching(/^fill: Type “Hello”/),
      expect.stringMatching(/^press Shift\+Enter: Press Shift\+Enter in .*Message/),
      // The new line it made: the field as it was left, before what is done next.
      expect.stringMatching(/^fill: Type “Hello”/),
      expect.stringMatching(/^upload: Choose “march\.pdf” in .*Invoice/),
      expect.stringMatching(/^drag: Drag .*Charlie.* onto .*Alpha/),
      expect.stringMatching(/^hover: Hover over .*Products/),
      expect.stringMatching(/^click: Click .*Laptops/),
      expect.stringMatching(/^hover: Hover over .*Account menu/),
      expect.stringMatching(/^click: Click .*Sign out everywhere/),
      'missed: Not recorded: something you did inside an embedded frame',
    ]);
  await expect(page.getByText('Not recorded: something you did inside an embedded frame')).toBeVisible();
});

test('steps find what was used by words a person reads, and by its row or its part of the page before its position', async ({ page }) => {
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  await app.locator('body').evaluate(() => {
    const box = document.createElement('div');
    box.innerHTML = `${Array.from({ length: 12 }, (_, i) => `<button class="vrow">Row ${i === 11 ? 3000 : i + 1}</button>`).join('')}
      <button>Load in 2 s</button>
      <form onsubmit="return false"><input type="submit" value="Send it"> <input type="image" alt="Search" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20"></form>
      <label>Fruit <input list="fruits"></label><datalist id="fruits"><option value="Apple"></option></datalist>
      <table><thead><tr><th>Name</th><th>Price</th></tr></thead><tbody><tr><td>Ada Lovelace</td><td>$12.00</td></tr><tr><td>Bao Nguyen</td><td>$12.00</td></tr></tbody></table>
      <section><h3>Billing</h3><p>Nothing here</p></section><section><h3>Shipping</h3><p>Nothing here</p></section>`;
    document.querySelector('main')!.prepend(box);
  });
  await app.getByRole('button', { name: 'Row 3000' }).click();
  await app.getByRole('button', { name: 'Load in 2 s' }).click();
  await app.getByRole('button', { name: 'Send it' }).click();
  await app.getByRole('button', { name: 'Search' }).click();
  await app.getByRole('combobox', { name: 'Fruit' }).fill('Apple');
  await app.getByRole('row', { name: /Bao/ }).getByText('$12.00').click();
  await app.locator('section').filter({ hasText: 'Shipping' }).getByText('Nothing here').click();
  const want = [
    "page.getByRole('button', { name: 'Row 3000' })",
    "page.getByRole('button', { name: 'Load in 2 s' })",
    "page.getByRole('button', { name: 'Send it' })",
    "page.getByRole('button', { name: 'Search' })",
    "page.getByRole('combobox', { name: 'Fruit' })",
    "page.getByRole('row').filter({ hasText: 'Bao Nguyen' }).locator('td').nth(1)",
    "page.locator('section').filter({ has: page.getByRole('heading', { name: 'Shipping', exact: true }) }).getByText('Nothing here', { exact: true })",
  ];
  await expect.poll(async () => (await store<{ locator: string }[]>(page, 's.recorder.steps')).map((s) => s.locator)).toEqual(want);
  const described = (await store<{ description: string }[]>(page, 's.recorder.steps')).map((s) => s.description);
  expect(described[5]).toBe('Click the “Price” cell for “Bao Nguyen”');
  // Each finds the one that was used, as Playwright finds it.
  for (const code of want) {
    const found = new Function('page', `return ${code}`)(app) as ReturnType<typeof app.locator>;
    await expect(found, code).toHaveCount(1);
  }
});

test('steps find what was used by the words written in the page, whatever a style or the markup makes of them', async ({ page }) => {
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  await app.locator('body').evaluate(() => {
    const box = document.createElement('div');
    // Capitals a style shows, an arrow kept from screen readers, a line break, spaces around a price in the markup.
    box.innerHTML = `<style>.up { text-transform: uppercase } .cap { text-transform: capitalize }</style>
      <button id="t1" class="up">Save</button> <button class="up">Save all</button>
      <button id="t2">Next <span aria-hidden="true">→</span></button>
      <span id="t3" class="up">Order status</span>
      <p id="t4" class="cap">shipping and returns</p>
      <div id="t5">First line<br>second line</div>
      <p id="t6">
         Amount due: $5.00
      </p>
      <p id="t7">Subtotal: $9.00</p>
      <h3 id="t8" class="up">Order summary</h3>`;
    document.querySelector('main')!.prepend(box);
  });
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
  for (const id of ids) await app.locator(`#${id}`).click();
  await expect.poll(async () => (await steps(page)).length).toBe(ids.length);
  const recorded = await store<{ locator: string; description: string }[]>(page, 's.recorder.steps');
  expect(recorded.map((s) => s.locator)).toEqual([
    "page.getByRole('button', { name: 'Save', exact: true })",
    "page.getByRole('button', { name: 'Next' })",
    "page.getByText('Order status', { exact: true })",
    "page.getByText('shipping and returns', { exact: true })",
    "page.getByText('First linesecond line', { exact: true })",
    'page.getByText(/^\\s*Amount\\s+due:\\s+\\$\\d[\\d.,]*\\s*$/)',
    'page.getByText(/^Subtotal: \\$\\d[\\d.,]*$/)',
    "page.getByRole('heading', { name: 'Order summary' })",
  ]);
  // A step names it by the words the page holds, as the test finds it.
  expect(recorded[2].description).toBe('Click “Order status”');
  // Each finds the one that was used, and only it, as Playwright finds it.
  for (const [i, { locator }] of recorded.entries()) {
    const found = new Function('page', `return ${locator}`)(app) as ReturnType<typeof app.locator>;
    await expect(found, locator).toHaveCount(1);
    expect(await found.getAttribute('id'), locator).toBe(ids[i]);
  }
  // A check said of what a style shows in capitals expects the words the page holds: what the test reads there.
  // (Of a part of the app itself: in an app whose code the studio reads, pointing is at what its code renders.)
  await app.locator('body').evaluate(() => document.head.appendChild(document.createElement('style')).append('main h1 { text-transform: uppercase }'));
  const title = (await app.getByRole('heading', { name: 'Your account' }).boundingBox())!;
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2, { steps: 2 });
  await expect.poll(() => store<string | null>(page, 's.hover && s.hover.tag')).toBe('h1');
  await page.waitForTimeout(800);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('this should say YOUR ACCOUNT');
  await page.keyboard.press('Enter');
  await expectIsland(page, /Check added/);
  const check = await store<{ locator: string; expected: string; anyCase?: boolean }>(page, 's.recorder.expectations[0]');
  expect(check).toMatchObject({ locator: "page.getByRole('heading', { name: 'Your account' })", expected: 'Your account' });
  expect(check.anyCase).toBeFalsy();
  await expect(new Function('page', `return ${check.locator}`)(app) as ReturnType<typeof app.locator>).toHaveText(check.expected);
});

test('a menu that opens on hover is hovered by its own word, however the pointer came to it and however the page opens it, and a test opens it the same way', async ({ page }) => {
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  await app.locator('body').evaluate(() => {
    const box = document.createElement('div');
    // A bar of menus, as a site's header has them. Each opens its own way: a style rule (written with nesting); the
    // page's code, on the menu; Tailwind's group-hover, as Tailwind 4 writes it; the page's code, on one button of
    // several. And links that only fade while the bar is hovered, which opens nothing.
    box.innerHTML = `<style>#bar { display: flex; gap: 50px; padding: 20px } #bar > div { position: relative }
      .sub, #js-sub, .pop, #tools-pop { position: absolute; top: 100%; left: 0; white-space: nowrap }
      .sub, #js-sub, #tools-pop { display: none }
      .menu { &:hover .sub { display: block } }
      @layer utilities { .hidden { display: none } @media (hover: hover) { :is(:where(.group):hover .group-hover\\:block) { display: block } } }
      #links:hover a { opacity: 0.6 } #links a:hover { opacity: 1 }</style>
      <button id="like">Like</button>
      <nav id="bar">
        <div class="menu"><span>Products</span><div class="sub"><button>Laptops</button><button>Desktops</button></div></div>
        <div id="js-menu"><span>Account menu</span><div id="js-sub"><button>Sign out everywhere</button></div></div>
        <div class="group"><span>Reports</span><div class="pop hidden group-hover:block"><button>Monthly</button></div></div>
        <div id="tools"><button>Other</button> <button id="more">More tools</button><div id="tools-pop"><button>Export</button></div></div>
        <div id="links"><a href="#/account">Docs</a> <a href="#/account">Blog</a></div>
      </nav>
      <p id="log" style="margin-top: 70px">Nothing yet</p>`;
    document.querySelector('main')!.prepend(box);
    const show = (id: string, on: boolean) => ((box.querySelector(id) as HTMLElement).style.display = on ? 'block' : 'none');
    box.querySelector('#js-menu')!.addEventListener('mouseenter', () => show('#js-sub', true));
    box.querySelector('#js-menu')!.addEventListener('mouseleave', () => show('#js-sub', false));
    box.querySelector('#more')!.addEventListener('mouseenter', () => show('#tools-pop', true));
    box.querySelector('#tools')!.addEventListener('mouseleave', () => show('#tools-pop', false));
    for (const b of Array.from(box.querySelectorAll('button'))) b.addEventListener('click', () => (box.querySelector('#log')!.textContent = `Did: ${b.textContent}`));
  });
  expect(await app.locator('body').evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true);
  await app.getByRole('button', { name: 'Like' }).click();
  // As a hand moves it: into the bar first, where no menu is, then onto a menu's word, then to what it opened.
  const bar = (await app.locator('#bar').boundingBox())!;
  const onto = async (word: ReturnType<typeof app.locator>) => {
    const at = (await word.boundingBox())!;
    await page.mouse.move(at.x + 5, bar.y + 4, { steps: 3 });
    await page.mouse.move(at.x + 5, at.y + 5, { steps: 4 });
  };
  await page.mouse.move(bar.x + 4, bar.y + 4, { steps: 3 });
  await onto(app.getByText('Products', { exact: true }));
  await app.getByRole('button', { name: 'Laptops' }).click();
  await onto(app.getByText('Account menu', { exact: true }));
  await app.getByRole('button', { name: 'Sign out everywhere' }).click();
  await onto(app.getByText('Reports', { exact: true }));
  await app.getByRole('button', { name: 'Monthly' }).click();
  // Into this one by another of its buttons, then along to the one that opens it.
  await onto(app.getByRole('button', { name: 'Other' }));
  const more = (await app.getByRole('button', { name: 'More tools' }).boundingBox())!;
  await page.mouse.move(more.x + 5, more.y + 5, { steps: 4 });
  await app.getByRole('button', { name: 'Export' }).click();
  await onto(app.getByRole('link', { name: 'Docs' }));
  await app.getByRole('link', { name: 'Docs' }).click();
  await expect
    .poll(async () => (await store<{ kind: string; locator: string; description: string }[]>(page, 's.recorder.steps')).map((s) => `${s.description} = ${s.locator}`))
    .toEqual([
      "Click the “Like” button = page.getByRole('button', { name: 'Like' })",
      "Hover over “Products” = page.getByText('Products', { exact: true })",
      "Click the “Laptops” button = page.getByRole('button', { name: 'Laptops' })",
      "Hover over “Account menu” = page.getByText('Account menu', { exact: true })",
      "Click the “Sign out everywhere” button = page.getByRole('button', { name: 'Sign out everywhere' })",
      "Hover over “Reports” = page.getByText('Reports', { exact: true })",
      "Click the “Monthly” button = page.getByRole('button', { name: 'Monthly' })",
      "Hover over the “More tools” button = page.getByRole('button', { name: 'More tools' })",
      "Click the “Export” button = page.getByRole('button', { name: 'Export' })",
      "Click the “Docs” link = page.getByRole('link', { name: 'Docs' })",
    ]);
  // A test does the same, from a pointer that is nowhere near: each hover opens its menu for the click after it.
  const recorded = await store<{ kind: string; locator: string }[]>(page, 's.recorder.steps');
  await page.evaluate(() => (window as any).__saywright.setMode('use'));
  await expect.poll(() => store<string>(page, 's.mode')).toBe('use');
  await page.mouse.move(2, 2);
  await expect(app.getByRole('button', { name: 'Laptops' })).toBeHidden();
  for (const { kind, locator } of recorded) {
    const found = new Function('page', `return ${locator}`)(app) as ReturnType<typeof app.locator>;
    if (kind === 'hover') await found.hover({ timeout: 5000 });
    else await found.click({ timeout: 5000 });
    const did = /name: '(Laptops|Sign out everywhere|Monthly|Export)'/.exec(locator)?.[1];
    if (kind === 'click' && did) await expect(app.locator('#log')).toHaveText(`Did: ${did}`);
  }
});

test('while writing a test, pointing reaches a value inside a web component, and an embedded frame is pointed at as itself', async ({ page }) => {
  await writeTestOnAccount(page);
  const app = page.frameLocator('iframe');
  await app.locator('body').evaluate(() => {
    const host = document.createElement('open-card');
    host.attachShadow({ mode: 'open' }).innerHTML = '<div style="padding:24px;border:1px solid"><h4>Customer</h4><span id="who">Hello, Ada (VIP)</span></div>';
    const section = document.createElement('section');
    section.innerHTML = '<h4>Payment</h4><iframe title="Pay" srcdoc="<p>Paid by Ada</p>" style="width:240px;height:80px"></iframe>';
    document.querySelector('main')!.prepend(host, section);
  });
  const hoverOn = async (target: ReturnType<typeof app.locator>) => {
    const b = (await target.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
  };
  await hoverOn(app.locator('open-card #who'));
  await expect.poll(() => store<{ tag: string; text: string } | null>(page, 's.hover && { tag: s.hover.tag, text: s.hover.text }')).toEqual({ tag: 'span', text: 'Hello, Ada (VIP)' });
  await hoverOn(app.locator('iframe[title="Pay"]'));
  await expect.poll(() => store<string | null>(page, 's.hover && s.hover.tag')).toBe('iframe');
});

test('after a reload the kept steps come back in Write test, and the Test tab says when the app is no longer where they end', async ({ page }) => {
  await writeTestOnAccount(page);
  await page.frameLocator('iframe').getByLabel('Email').fill('me@example.com');
  await page.frameLocator('iframe').getByText('Show password').click();
  await expect.poll(async () => (await steps(page)).length).toBe(2);
  await page.waitForTimeout(500);
  await page.reload();
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  await expect.poll(async () => (await steps(page)).length).toBe(2);
  // The app came back on its start page; the steps end on the account page.
  const notice = page.locator('[data-kept-elsewhere]');
  await expect(notice).toContainText(/opened again on .*these steps end on .*#\/account/);
  // The steps stay until the person decides.
  await notice.getByRole('button', { name: 'Carry on anyway' }).click();
  await expect(notice).toBeHidden();
  expect((await steps(page)).length).toBe(2);
});

test('each app keeps its own test being written: switching away and back, and opening it again after a reload', async ({ page }) => {
  const site = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Other</title><h1>Other app</h1><button>Go</button>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://localhost:${(site.address() as AddressInfo).port}`;
  const call = async <T>(method: string, route: string, body?: unknown): Promise<T> =>
    (await fetch(`${STUDIO}/api${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<T>;
  const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { url: `${origin}/` });
  const other = (await call<{ app: { id: string } }>('POST', '/apps', { probe, url: `${origin}/` })).app.id;
  const shop = (await call<{ apps: { id: string; root: string | null }[] }>('GET', '/apps')).apps.find((a) => a.root?.endsWith('.e2e-shop'))!.id;
  try {
    // Linking it opened it: the shop first.
    await call('POST', `/apps/${shop}/open`, { decide: 'undo' });
    await writeTestOnAccount(page);
    await page.frameLocator('iframe').getByLabel('Email').fill('me@example.com');
    await page.frameLocator('iframe').getByText('Show password').click();
    await expect.poll(async () => (await steps(page)).length).toBe(2);
    // Another app: its own (empty) test; the shop's is kept.
    await call('POST', `/apps/${other}/open`, { decide: 'undo' });
    await expect.poll(() => store<string>(page, 's.app.title')).toBe('Other');
    expect((await steps(page)).length).toBe(0);
    expect(await store<string>(page, 's.mode')).not.toBe('record');
    await page.evaluate(() => (window as any).__saywright.setMode('record'));
    await page.frameLocator('iframe').getByRole('button', { name: 'Go' }).click();
    await expect.poll(async () => (await steps(page)).length).toBe(1);
    // Back: the shop's test, and Write test as it was.
    await call('POST', `/apps/${shop}/open`, { decide: 'undo' });
    await expect.poll(async () => (await steps(page)).length).toBe(2);
    expect(await store<string>(page, 's.mode')).toBe('record');
    // The other app open, the tab reloaded, then the shop opened from the list: its test is back.
    await call('POST', `/apps/${other}/open`, { decide: 'undo' });
    await expect.poll(async () => (await steps(page)).length).toBe(1);
    await page.waitForTimeout(500);
    await page.reload();
    await expect.poll(() => store<string>(page, 's.app.title')).toBe('Other');
    await call('POST', `/apps/${shop}/open`, { decide: 'undo' });
    await expect.poll(async () => (await steps(page)).length).toBe(2);
    expect((await steps(page)).map((s) => s.kind)).toEqual(['fill', 'fill']);
  } finally {
    await call('POST', `/apps/${shop}/open`, { decide: 'undo' }).catch(() => undefined);
    await call('DELETE', `/apps/${other}`).catch(() => undefined);
    site.close();
  }
});
