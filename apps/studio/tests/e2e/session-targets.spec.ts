/**
 * What a session says about the controls a tester used: a small one is a problem only when something else to click
 * is close enough to hit by mistake (WCAG 2.5.8 and its spacing exception), as the Experts judge it.
 */
import { expect, test } from '@playwright/test';
import { openStudio, resetAll, STUDIO } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetAll();
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
});

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

test('a small control with room around it isn’t called too small; two small ones side by side are', async ({ page }) => {
  await openStudio(page);
  const app = page.frameLocator('iframe');
  await app.locator('body').evaluate(() => {
    const box = document.createElement('section');
    const small = 'display:inline-block;width:20px;height:20px;padding:0;border:0;font-size:10px';
    box.innerHTML = `<div style="padding:40px"><button type="button" style="${small}">Lone</button></div>
      <div style="padding:40px"><button type="button" style="${small}">Up</button><button type="button" style="${small}">Down</button></div>`;
    document.querySelector('main')!.prepend(box);
  });
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Small controls');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await app.getByRole('button', { name: 'Lone' }).click();
  await app.getByRole('button', { name: 'Up' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const id = await sessionNamed('Small controls');
  const { analysis } = (await (await fetch(`${STUDIO}/api/sessions/${id}`)).json()) as { analysis: { issues: { kind: string; title: string }[] } };
  const small = analysis.issues.filter((g) => g.title.startsWith('Small target')).map((g) => g.title);
  expect(small).toEqual([expect.stringContaining('“Up”')]);
});
