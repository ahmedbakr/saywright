/**
 * Expert reviews: the checks run in the app's page (SEO, content, UI/UX and
 * accessibility with axe-core), Show selects what a finding is about, Fix
 * sends it to the AI and the next review no longer finds it, the AI expert's
 * judgement is kept with the review, and a page on another stack is reviewed
 * through the proxy, with its review kept in that app's own data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { E2E_SHOP, openStudio, resetAll, SHOP_URL, shopFile, store, STUDIO, waitForApp } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = { onboarded: true, theme: 'dark', ui: { panelOpen: true, panelTab: 'experts', device: 'fill', commitOnKeep: false } };

const call = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${STUDIO}/api${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
};

interface Review {
  url: string;
  checks: { key: string; rule: string; expert: string; severity: string; what?: string }[];
  crawl: { local: boolean } | null;
  ai: Record<string, { summary: string } | undefined>;
}

const finding = (page: Page, expert: string, rule: string) => page.locator(`[data-expert="${expert}"] [data-finding="${rule}"]`);

async function review(page: Page): Promise<void> {
  await page.locator('[data-review-page]').click();
  await expect(page.locator('[data-review-page]')).toHaveText(/Review again/, { timeout: 30_000 });
}

test.beforeEach(() => resetAll());

test('review the shop: findings with their rules, Show selects the element, and a fix makes the finding go away', async ({ page }) => {
  await openStudio(page, SETTINGS);
  await expect(page.locator('[data-review-page]')).toHaveText('Review this page');
  await review(page);
  // What the checks found on the sample shop, each under its expert.
  await expect(finding(page, 'seo', 'SEO-19')).toContainText('No meta description');
  await expect(finding(page, 'seo', 'SEO-29')).toContainText('Pages addressed by #fragments');
  await expect(finding(page, 'a11y', 'axe:color-contrast')).toContainText('Text with too little contrast');
  await expect(page.locator('[data-expert="content"]')).toBeVisible();
  await expect(page.locator('[data-expert="ux"]')).toBeVisible();

  // Show: the element the finding is about, selected and in its place in the code.
  const contrast = finding(page, 'a11y', 'axe:color-contrast');
  await contrast.getByRole('button', { expanded: false }).click();
  await expect(contrast).toContainText('WCAG 1.4.3');
  await contrast.getByRole('button', { name: 'Show' }).click();
  await expect.poll(() => store<string | null>(page, 's.selection?.src ?? null')).toMatch(/^src\/.+\.tsx:\d+:\d+$/);

  // Fix: the AI gets the finding and its rule, and the change waits for keep or undo.
  const meta = finding(page, 'seo', 'SEO-19');
  await meta.getByRole('button', { expanded: false }).click();
  await meta.getByRole('button', { name: /^Fix with/ }).click();
  await expect.poll(() => shopFile('index.html')).toContain('<meta name="description"');
  await expect(page.locator('[data-island]')).toContainText('Adds a meta description');
  await page.getByRole('button', { name: /^Keep/ }).first().click();
  await expect(page.locator('[data-island]')).not.toContainText('Adds a meta description');

  // The page loads again with it, and the next review doesn't find it.
  await waitForApp(page);
  await page.locator('[role="tab"]', { hasText: 'Experts' }).click();
  await expect.poll(async () => page.frameLocator('iframe').locator('meta[name="description"]').count(), { timeout: 15_000 }).toBe(1);
  await review(page);
  await expect(finding(page, 'seo', 'SEO-19')).toHaveCount(0);
  await expect(finding(page, 'seo', 'SEO-29')).toHaveCount(1);
});

test('the AI expert is shown what it might call missing, and each #/route is a page of its own', async ({ page }) => {
  await openStudio(page, SETTINGS);
  // A link that is only a picture, and a field that asks for the number keyboard.
  await page.frameLocator('iframe').locator('body').evaluate(() => {
    const box = document.createElement('div');
    const img = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>');
    box.innerHTML = `<a href="#/account"><img alt="Your account" src="${img}" width="20" height="20"></a><label>Card code <input inputmode="numeric" autocomplete="cc-csc"></label>`;
    document.querySelector('main')!.prepend(box);
  });
  await review(page);
  const checkout = await store<string>(page, 's.app.url');
  type Facts = { landmarks?: { role: string; name: string }[]; live?: { role: string; text: string }[]; linkTargets?: { text: string; href: string }[]; forms: { label: string; inputmode?: string }[] };
  const { review: r } = await call<{ review: Review & { facts: Facts } }>('GET', `/experts/review?url=${encodeURIComponent(checkout)}`);
  // Named as a screen reader names it, by its picture; and the keyboard the field asks for.
  expect(r.facts.linkTargets).toContainEqual({ text: 'Your account', href: '#/account' });
  expect(r.facts.forms).toContainEqual(expect.objectContaining({ label: 'Card code', inputmode: 'numeric' }));
  // The page's landmarks, its live regions and where its links go, as written.
  expect(r.facts.landmarks?.map((l) => l.role)).toEqual(expect.arrayContaining(['banner', 'navigation', 'main']));
  expect(r.facts.landmarks).toContainEqual({ role: 'navigation', name: 'Main' });
  expect(Array.isArray(r.facts.live)).toBe(true);
  expect(r.facts.linkTargets).toContainEqual({ text: 'Shop', href: '#/shop' });
  // The hash-route check names what it found.
  expect(r.checks.find((c) => c.rule === 'SEO-29')?.what).toContain('#/shop');

  // The shop, at #/shop, is reviewed as its own page: the checkout's review stays.
  await page.getByRole('radio', { name: 'Use' }).click();
  await page.frameLocator('iframe').getByRole('link', { name: 'Shop', exact: true }).click();
  await expect.poll(() => store<string>(page, 's.app.url')).toMatch(/#\/shop$/);
  await page.getByRole('radio', { name: 'Edit' }).click();
  await review(page);
  const urls = (await call<{ reviews: { url: string }[] }>('GET', '/experts/reviews')).reviews.map((x) => x.url);
  expect(urls).toHaveLength(2);
  expect(urls.some((u) => u.endsWith('#/shop'))).toBe(true);
});

test('ask the AI expert: its summary, a verdict on each check and its own findings, kept with the review', async ({ page }) => {
  await openStudio(page, SETTINGS);
  await review(page);
  const seo = page.locator('[data-expert="seo"]');
  await seo.locator('[data-ask-ai="seo"]').click();
  await expect(seo.locator('[data-ai-summary]')).toContainText('The first problem listed matters most');
  // Verdicts on the checks: confirmed, and the last one dismissed as harmless here.
  const rows = seo.locator('[data-finding]');
  await expect(rows.first()).toContainText('Confirmed: It matters on this page.');
  await expect(seo).toContainText('Dismissed: Harmless on this page.');
  // Its own finding, with the words to change.
  const own = seo.locator('[data-finding="heuristic"]');
  await expect(own).toContainText('Say what the main button does');
  await own.getByRole('button', { expanded: false }).click();
  await expect(own).toContainText('Apply code');
  await expect(seo.locator('[data-ask-ai="seo"]')).toHaveText(/Again/);

  // Saved: the studio shows the same review after a reload.
  const url = await store<string>(page, 's.app.url');
  const { review: saved } = await call<{ review: Review }>('GET', `/experts/review?url=${encodeURIComponent(url)}`);
  expect(saved.ai.seo?.summary).toContain('The first problem listed matters most');
  await page.reload();
  await waitForApp(page);
  await expect(page.locator('[data-expert="seo"] [data-ai-summary]')).toContainText('The first problem listed matters most');
  await expect(page.locator('[data-review-page]')).toHaveText('Review again');
});

test('a plain HTML site through the proxy: reviewed with accessibility checks, and kept in that app’s own data', async ({ page }) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-plain-'));
  fs.cpSync(path.resolve(here, '../fixtures/apps/plain'), folder, { recursive: true });
  const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { folder });
  const { app } = await call<{ app: { id: string } }>('POST', '/apps', { probe, open: false });
  const shop = (await call<{ apps: { id: string; root: string | null }[] }>('GET', '/apps')).apps.find((a) => a.root?.endsWith('.e2e-shop'))!.id;
  try {
    await call('POST', `/apps/${app.id}/open`);
    await openStudio(page, SETTINGS);
    await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Your notes' })).toBeVisible();
    await review(page);
    const url = await store<string>(page, 's.app.url');
    const { review: r } = await call<{ review: Review }>('GET', `/experts/review?url=${encodeURIComponent(url)}`);
    // Saved under the site's own address, not the proxy's.
    expect(r.url).not.toBe(url);
    expect(new URL(r.url).pathname).toBe('/');
    expect(r.crawl?.local).toBe(true);
    // The page's CSP didn't keep axe-core out.
    expect(r.checks.some((c) => c.rule === 'axe:unavailable')).toBe(false);
    await expect(finding(page, 'seo', 'SEO-19')).toBeVisible();
    await expect(page.locator('[data-expert="a11y"]')).toBeVisible();
    const here = (await call<{ reviews: { url: string }[] }>('GET', '/experts/reviews')).reviews;
    expect(here.map((x) => x.url)).toEqual([r.url]);
  } finally {
    await call('POST', `/apps/${shop}/open`, { decide: 'undo' }).catch(() => undefined);
    await call('DELETE', `/apps/${app.id}`).catch(() => undefined);
  }
  // The shop's reviews are its own.
  const shopReviews = (await call<{ reviews: { url: string }[] }>('GET', '/experts/reviews')).reviews;
  expect(shopReviews.every((x) => x.url.startsWith(`${SHOP_URL}/`))).toBe(true);
  expect(fs.existsSync(path.join(E2E_SHOP, 'index.html'))).toBe(true);
});

test('every check, on a page built with known problems, and none on a clean page', async ({ page }) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-flawed-'));
  fs.cpSync(path.resolve(here, '../fixtures/apps/flawed'), folder, { recursive: true });
  const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { folder });
  const { app } = await call<{ app: { id: string } }>('POST', '/apps', { probe, open: false });
  const shop = (await call<{ apps: { id: string; root: string | null }[] }>('GET', '/apps')).apps.find((a) => a.root?.endsWith('.e2e-shop'))!.id;
  const rules = async () => {
    const { review: r } = await call<{ review: Review }>('GET', `/experts/review?url=${encodeURIComponent(await store<string>(page, 's.app.url'))}`);
    return r.checks.filter((c) => c.severity !== 'info' || c.rule.startsWith('SEO')).map((c) => `${c.expert} ${c.rule}`).sort();
  };
  try {
    await call('POST', `/apps/${app.id}/open`);
    await openStudio(page, SETTINGS);
    await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Lantern for teams' })).toBeVisible();
    await review(page);
    // Each problem in the page is found once, by the expert whose rule covers it.
    expect(await rules()).toEqual(
      [
        'seo SEO-05', 'seo SEO-13', 'seo SEO-16', 'seo SEO-17', 'seo SEO-19', 'seo SEO-20', 'seo SEO-21', 'seo SEO-22', 'seo SEO-23', 'seo SEO-25', 'seo SEO-31', 'seo SEO-37', 'seo SEO-38', 'seo SEO-40',
        'content CNT-01', 'content CNT-02', 'content CNT-06', 'content CNT-07',
        'ux UX-01', 'ux UX-06', 'ux UX-07', 'ux UX-08', 'ux UX-08', 'ux UX-09', 'ux UX-14', 'ux UX-16', 'ux UX-17',
        'a11y axe:button-name', 'a11y axe:html-has-lang', 'a11y axe:image-alt', 'a11y axe:label', 'a11y axe:meta-viewport', 'a11y axe:target-size',
      ].sort(),
    );
    // Show finds the element on the page: the field with no label.
    const label = finding(page, 'a11y', 'axe:label');
    await label.getByRole('button', { expanded: false }).click();
    await label.getByRole('button', { name: 'Show' }).click();
    await expect.poll(() => store<string | null>(page, 's.selection?.tag ?? null')).toBe('input');

    // The clean page: nothing.
    await page.getByRole('radio', { name: 'Use' }).click();
    await page.frameLocator('iframe').locator('#good').click();
    await expect.poll(() => store<string>(page, 's.app.url')).toMatch(/\/good\.html$/);
    await waitForApp(page);
    await page.locator('[data-review-page]').click();
    await expect(page.locator('[data-expert="seo"]')).toContainText('Nothing found', { timeout: 30_000 });
    expect(await rules()).toEqual([]);
    for (const e of ['seo', 'content', 'ux', 'a11y']) await expect(page.locator(`[data-expert="${e}"]`)).toContainText('Nothing found');

    // The same page with a canonical naming another site than its og:url: that one problem.
    await page.frameLocator('iframe').locator('body').evaluate(() => location.assign('/elsewhere.html'));
    await expect.poll(() => store<string>(page, 's.app.url')).toMatch(/\/elsewhere\.html$/);
    await waitForApp(page);
    await page.locator('[data-review-page]').click();
    await expect(page.locator('[data-expert="seo"]')).toContainText('The canonical points to another site', { timeout: 30_000 });
    expect(await rules()).toEqual(['seo SEO-13']);
  } finally {
    await call('POST', `/apps/${shop}/open`, { decide: 'undo' }).catch(() => undefined);
    await call('DELETE', `/apps/${app.id}`).catch(() => undefined);
  }
});

test('Google data: each app keeps its own properties, checked before they are saved', async () => {
  type Google = { apiKey: string | null; account: unknown; settings: { searchConsoleSite?: string; ga4Property?: string }; publicUrl: string | null };
  const put = (settings: Record<string, string>) => fetch(`${STUDIO}/api/connectors/google`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
  const bad = await put({ ga4Property: 'G-1A2B3C4D5E' });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain('not the G-… measurement ID');
  expect((await put({ searchConsoleSite: 'example.com' })).status).toBe(400);
  const ok = (await (await put({ searchConsoleSite: 'sc-domain:tidewell.shop', ga4Property: '123456789' })).json()) as Google;
  expect(ok.settings).toEqual({ searchConsoleSite: 'sc-domain:tidewell.shop', ga4Property: '123456789' });
  // The sample shop has no production address, so there is nothing of Google's to test against yet.
  expect(ok.publicUrl).toBeNull();
  const t = await call<{ ok: boolean; message: string }>('POST', '/connectors/google/test');
  expect(t.ok).toBe(false);
  expect(t.message).toContain('no public address');
  // Another app starts with none of the shop's.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-plain-'));
  fs.cpSync(path.resolve(here, '../fixtures/apps/plain'), folder, { recursive: true });
  const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { folder });
  const { app } = await call<{ app: { id: string } }>('POST', '/apps', { probe, open: false });
  const shop = (await call<{ apps: { id: string; root: string | null }[] }>('GET', '/apps')).apps.find((a) => a.root?.endsWith('.e2e-shop'))!.id;
  try {
    await call('POST', `/apps/${app.id}/open`);
    expect((await call<Google>('GET', '/connectors/google')).settings).toEqual({});
  } finally {
    await call('POST', `/apps/${shop}/open`, { decide: 'undo' }).catch(() => undefined);
    await call('DELETE', `/apps/${app.id}`).catch(() => undefined);
  }
  expect((await call<Google>('GET', '/connectors/google')).settings.ga4Property).toBe('123456789');
  await put({ searchConsoleSite: '', ga4Property: '' });
});
