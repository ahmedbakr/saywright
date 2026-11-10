/**
 * Expert reviews on the server: robots.txt rules as Google reads them, what
 * the crawler reports, the saved review per page, what the AI expert is
 * shown and how its answer is kept, and the experts as Agent Skills.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ElementInfo, PageCheck, PageFacts, PageReview } from '@saywright/vite/protocol';
import type { JsonRequest } from '../../server/ai/service';
import { crawl, robotsBlocks } from '../../server/experts/crawl';
import { ExpertAnswer, ReviewStore, aiReview, expertPrompt, installSkills, pageKey, reviewPage, skillsAnswer } from '../../server/experts/index';
import { EXPERTS, skillFile, systemPromptFor } from '../../server/experts/instructions';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-experts-'));

describe('robots.txt, as Google reads it', () => {
  it('lets the longest matching rule win, and Allow win a tie', () => {
    const txt = 'User-agent: *\nDisallow: /shop\nAllow: /shop/public\nDisallow: /a\nAllow: /a';
    expect(robotsBlocks(txt, '/shop/cart').blocked).toBe(true);
    expect(robotsBlocks(txt, '/shop/public/x')).toEqual({ blocked: false, rule: 'Allow: /shop/public' });
    expect(robotsBlocks(txt, '/a/b').blocked).toBe(false);
    expect(robotsBlocks(txt, '/about-us').blocked).toBe(false);
  });

  it('understands * and $', () => {
    const txt = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?sort=';
    expect(robotsBlocks(txt, '/files/guide.pdf').blocked).toBe(true);
    expect(robotsBlocks(txt, '/files/guide.pdf?x=1').blocked).toBe(false);
    expect(robotsBlocks(txt, '/list?sort=price').blocked).toBe(true);
    expect(robotsBlocks(txt, '/list').blocked).toBe(false);
  });

  it('uses the group for Googlebot when there is one, ignoring the others', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot/2.1\nDisallow: /private\n\nUser-agent: googlebot-news\nDisallow: /';
    expect(robotsBlocks(txt, '/products').blocked).toBe(false);
    expect(robotsBlocks(txt, '/private/x').blocked).toBe(true);
    // A crawler whose name merely starts the same way isn't Googlebot.
    expect(robotsBlocks('User-agent: google\nDisallow: /', '/').blocked).toBe(false);
  });

  it('shares rules between agents listed together, and treats an empty Disallow as allowing all', () => {
    const txt = '# comment\nUser-agent: bingbot\nUser-agent: googlebot\nDisallow: /tmp # trailing\n\nUser-agent: *\nDisallow:';
    expect(robotsBlocks(txt, '/tmp/1').blocked).toBe(true);
    expect(robotsBlocks(txt, '/tmp/1', 'otherbot').blocked).toBe(false);
  });
});

describe('the crawler', () => {
  let server: http.Server;
  let base = '';
  const routes: Record<string, (res: http.ServerResponse) => void> = {
    '/': (res) => res.writeHead(301, { Location: '/start' }).end(),
    '/start': (res) => res.writeHead(302, { Location: '/page' }).end(),
    '/page': (res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><title>x</title></html>'),
    '/hidden': (res) => res.writeHead(200, { 'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex, nofollow' }).end('<html></html>'),
    '/gone': (res) => res.writeHead(404).end(),
    '/robots.txt': (res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nDisallow: /private\nSitemap: /sitemap.xml\n'),
    '/private/page': (res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html></html>'),
    '/sitemap.xml': (res) => res.writeHead(200, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><urlset><url><loc>${base}/page</loc></url><url><loc>${base}/other</loc></url></urlset>`),
  };
  beforeAll(async () => {
    server = http.createServer((req, res) => (routes[req.url ?? ''] ?? ((r: http.ServerResponse) => r.writeHead(404).end()))(res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('follows each redirect hop and reports the chain', async () => {
    const { facts, checks } = await crawl(`${base}/`, { assumePublic: true });
    expect(facts.status).toBe(200);
    expect(facts.finalUrl).toBe(`${base}/page`);
    expect(facts.redirects.map((r) => r.status)).toEqual([301, 302]);
    const chain = checks.find((c) => c.rule === 'SEO-02');
    expect(chain?.severity).toBe('medium');
    expect(chain?.what).toMatch(/Temporary redirects/);
    // robots.txt allows it and the sitemap lists it.
    expect(facts.robots).toMatchObject({ status: 200, blocks: false });
    expect(facts.robots?.sitemaps).toEqual(['/sitemap.xml']);
    expect(checks.find((c) => c.rule === 'SEO-08')?.title).toMatch(/relative/);
    expect(facts.sitemap).toMatchObject({ status: 200, urls: 2, listsPage: true });
    expect(checks.some((c) => c.rule === 'SEO-11' || c.rule === 'SEO-10')).toBe(false);
  });

  it('flags noindex headers, error statuses, robots.txt blocks and pages missing from the sitemap', async () => {
    expect((await crawl(`${base}/hidden`, { assumePublic: true })).checks.find((c) => c.rule === 'SEO-05')?.severity).toBe('blocker');
    expect((await crawl(`${base}/gone`, { assumePublic: true })).checks.find((c) => c.rule === 'SEO-01')?.severity).toBe('blocker');
    const blocked = await crawl(`${base}/private/page`, { assumePublic: true });
    expect(blocked.checks.find((c) => c.rule === 'SEO-09')?.what).toContain('Disallow: /private');
    expect(blocked.checks.find((c) => c.rule === 'SEO-11')?.title).toMatch(/doesn’t list this page/);
  });

  it('leaves robots.txt and the sitemap alone for an address on this computer', async () => {
    const { facts, checks } = await crawl(`${base}/page`);
    expect(facts.local).toBe(true);
    expect(facts.robots).toBeNull();
    expect(facts.sitemap).toBeNull();
    expect(checks).toEqual([]);
  });

  it('says so when the page doesn’t answer', async () => {
    const { checks } = await crawl('http://127.0.0.1:1/', { assumePublic: true });
    expect(checks[0]).toMatchObject({ rule: 'SEO-01', severity: 'high' });
  });
});

// ── reviews ──

const el = (id: number, text: string, src?: string): ElementInfo => ({ id, tag: 'button', text, label: text, name: null, role: 'button', src, rect: { x: 0, y: 0, w: 10, h: 10 } }) as unknown as ElementInfo;

const facts = (url: string): PageFacts =>
  ({
    url,
    title: 'Tidewell · Checkout',
    description: null,
    canonical: null,
    robots: null,
    lang: 'en',
    dir: null,
    viewport: 'width=device-width',
    headings: [
      { level: 1, text: 'Checkout' },
      { level: 2, text: 'Your order' },
    ],
    og: {},
    jsonLd: [],
    words: 120,
    text: 'Checkout. Your order. Apply a coupon.',
    links: { internal: 2, external: 0 },
    images: 0,
    forms: [{ label: 'Coupon', type: 'text', required: false }],
    buttons: ['Apply'],
    lcp: 400,
    cls: 0,
    readability: null,
    elements: [el(7, 'Place order', 'src/pages/Checkout.tsx:40:9')],
  }) as unknown as PageFacts;

const check = (rule: string, expert: PageCheck['expert'], severity: PageCheck['severity'], els?: ElementInfo[]): PageCheck => ({ rule, expert, severity, title: `${rule} title`, what: `${rule} what`, fix: `${rule} fix`, els });

function pageReview(url: string, checks: PageCheck[]): PageReview {
  return { facts: facts(url), checks, ms: 12 };
}

describe('saved reviews', () => {
  it('keeps one review per page, numbers the checks, and keeps an AI review of an expert not checked again', async () => {
    const store = new ReviewStore(tmp());
    const url = 'http://localhost:5174/checkout?x=1#top';
    const r1 = await reviewPage(store, pageReview(url, [check('SEO-19', 'seo', 'low'), check('axe:label', 'a11y', 'high', [el(3, 'Coupon')])]), ['content', 'a11y'], url);
    expect(r1.checks.map((c) => c.key)).toEqual(['c1', 'c2']);
    // Without SEO, no crawl.
    expect(r1.crawl).toBeNull();
    store.save({ ...r1, ai: { a11y: { summary: 'old', verdicts: {}, findings: [], model: 'm', at: 1 }, content: { summary: 'keep me', verdicts: {}, findings: [], model: 'm', at: 1 } } });
    const r2 = await reviewPage(store, pageReview(url, [check('axe:label', 'a11y', 'high')]), ['a11y'], url);
    expect(Object.keys(r2.ai)).toEqual(['content']);
    // The same page whatever its query and #anchor.
    expect(store.get('http://localhost:5174/checkout')?.key).toBe(r2.key);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].counts).toEqual({ high: 1 });
  });

  it('keeps the pages of an app that routes by #/ apart', async () => {
    expect(pageKey('http://localhost:5174/#/shop')).not.toBe(pageKey('http://localhost:5174/#/checkout'));
    expect(pageKey('http://localhost:5174/#/checkout?step=2')).toBe(pageKey('http://localhost:5174/#/checkout'));
    expect(pageKey('http://localhost:5174/#top')).toBe(pageKey('http://localhost:5174/'));
    const store = new ReviewStore(tmp());
    for (const url of ['http://localhost:5174/#/shop', 'http://localhost:5174/#/checkout']) await reviewPage(store, pageReview(url, [check('SEO-29', 'seo', 'high')]), ['a11y'], url);
    expect(store.list().map((r) => r.url).sort()).toEqual(['http://localhost:5174/#/checkout', 'http://localhost:5174/#/shop']);
    expect(store.get('http://localhost:5174/#/shop')?.url).toBe('http://localhost:5174/#/shop');
  });
});

describe('the AI expert', () => {
  it('is shown the page, the checks with their keys and the elements it may point at', async () => {
    const store = new ReviewStore(tmp());
    const url = 'http://localhost:5174/';
    const r = await reviewPage(store, pageReview(url, [check('SEO-19', 'seo', 'low'), check('axe:color-contrast', 'a11y', 'high', [el(5, 'Total', 'src/pages/Checkout.tsx:12:3')])]), ['a11y'], url);
    const { text, elements } = expertPrompt({ ...r, field: { crux: { lcp: 2100, inp: 180, cls: 0.02, scope: 'origin', period: '2026-09-01 to 2026-09-28' } } }, 'a11y');
    expect(text).toContain('Title: Tidewell · Checkout');
    expect(text).toContain('Meta description: (none)');
    expect(text).toContain('H1 Checkout\n  H2 Your order');
    // Each check with its evidence on its own lines.
    expect(text).toContain('c2 [axe:color-contrast] (high) axe:color-contrast title. axe:color-contrast what\n   Evidence (1 element): e1 button (button) “Total” at src/pages/Checkout.tsx:12:3');
    // Only this expert's checks; the others' are named as covered by them.
    expect(text).not.toContain('[SEO-19]');
    expect(text).toContain('<covered_by_other_experts>\n[SEO] SEO-19 title\n</covered_by_other_experts>');
    expect(text).toContain('Real users (Chrome UX Report, the whole site, phones, 75th percentile): LCP 2100 ms, INP 180 ms, CLS 0.02');
    expect(text).toContain('<elements>\ne2: button (button) “Place order” at src/pages/Checkout.tsx:40:9\n</elements>');
    expect(elements.map((e) => e.id)).toEqual([5, 7]);
    expect(systemPromptFor('a11y')).toContain('WCAG 2.2');
  });

  it('is shown what it would otherwise call missing: landmarks, live regions, where links go, the full address', async () => {
    const store = new ReviewStore(tmp());
    const url = 'http://localhost:5174/#/checkout';
    const review = pageReview(url, [check('SEO-29', 'seo', 'high')]);
    review.facts = {
      ...review.facts,
      landmarks: [{ role: 'banner', name: '' }, { role: 'navigation', name: 'Main' }, { role: 'main', name: '' }],
      live: [{ role: 'status', text: 'Added Celadon mug' }],
      linkTargets: [{ text: 'Shop', href: '#/shop' }, { text: 'Checkout', href: '#/checkout' }, { text: '(no name)', href: '#/cart' }],
      forms: [{ label: 'Code', type: 'text', autocomplete: 'one-time-code', required: true, inputmode: 'numeric' }],
      buttons: ['Close', '(no name)'],
    };
    const r = await reviewPage(store, review, ['a11y'], url);
    const { text } = expertPrompt(r, 'seo');
    expect(text).toContain('<page url="http://localhost:5174/#/checkout">');
    expect(text).toContain('Landmarks: banner, navigation “Main”, main');
    expect(text).toContain('Live regions on the page now: status “Added Celadon mug”');
    expect(text).toContain('Links (named as a screen reader names them → where they go, as written): “Shop” → #/shop · “Checkout” → #/checkout · (no name) → #/cart');
    // A field's keyboard, and buttons by their names (an icon button by its label), so neither is called missing.
    expect(text).toContain('Code [text, autocomplete=one-time-code, inputmode=numeric, required]');
    expect(text).toContain('Buttons (named as a screen reader names them): “Close”, (no name)');
    // None there: said so, and that what appears later isn't listed.
    const bare = expertPrompt({ ...r, facts: { ...r.facts, landmarks: [], live: [] } }, 'a11y').text;
    expect(bare).toContain('Landmarks: (none)');
    expect(bare).toMatch(/Live regions on the page now: \(none; one that appears later, like a toast, isn’t listed\)/);
    // From an older plugin that doesn't collect them: not a reason to call them missing.
    const old = expertPrompt({ ...r, facts: { ...r.facts, landmarks: undefined, live: undefined } }, 'a11y').text;
    expect(old).toContain('Landmarks: (not collected: don’t judge them)');
  });

  it('is told never to call something missing that the facts don’t show missing, to stay in its area, and to fix at the root', () => {
    for (const id of ['seo', 'content', 'ux', 'a11y'] as const) {
      const system = systemPromptFor(id);
      expect(system).toContain('Never say something is missing');
      expect(system).toContain('<covered_by_other_experts> are theirs');
      expect(system).toContain('fix its design token or shared style, not each element');
    }
  });

  it('shows a sample of a check’s elements as such', async () => {
    const store = new ReviewStore(tmp());
    const url = 'http://localhost:5174/';
    const many = { ...check('axe:color-contrast', 'a11y', 'high', [el(1, 'Secure checkout', 'src/components/Header.tsx:17:7'), el(2, 'Ash glaze', 'src/components/LineItems.tsx:14:15'), el(3, 'Huila', 'src/components/LineItems.tsx:14:15'), el(4, 'Free returns')]), count: 5, html: ['<div class="header-end">Secure checkout</div>'] };
    const r = await reviewPage(store, pageReview(url, [many]), ['a11y'], url);
    const { text } = expertPrompt(r, 'a11y');
    expect(text).toContain('   Evidence (3 of 5 elements): e1 button (button) “Secure checkout” at src/components/Header.tsx:17:7; e2 button (button) “Ash glaze” at src/components/LineItems.tsx:14:15; e3 button (button) “Huila”');
    expect(text).toContain('\n   <div class="header-end">Secure checkout</div>');
  });

  it('keeps the verdicts for real checks, ties findings to elements and keeps a rewrite only when it changes something', async () => {
    const store = new ReviewStore(tmp());
    const url = 'http://localhost:5174/';
    const r = await reviewPage(store, pageReview(url, [check('CNT-06', 'content', 'medium', [el(9, 'Submit')]), check('CNT-01', 'content', 'low')]), ['content'], url);
    let asked: JsonRequest<unknown> | null = null;
    const answer = {
      summary: 'Clear page; the button is vague.',
      verdicts: [
        { check: 'c1', verdict: 'confirmed', note: 'Vague here.' },
        { check: 'c2', verdict: 'dismissed', note: 'Fine for a checkout.' },
        { check: 'c99', verdict: 'confirmed', note: 'No such check.' },
      ],
      findings: [
        { rule: 'CNT-06', severity: 'medium', title: 'Name the action', what: 'The button says Submit.', fix: 'Say what happens.', element: 'e1', before: 'Submit', after: 'Place order' },
        { rule: 'heuristic', severity: 'low', title: 'Same words', what: 'x', fix: 'y', element: 'e42', before: 'Same', after: 'Same' },
        ...Array.from({ length: 9 }, (_, i) => ({ rule: 'heuristic', severity: 'info' as const, title: `extra ${i}`, what: '', fix: '' })),
      ],
    };
    expect(ExpertAnswer.safeParse(answer).success).toBe(true);
    const ask = async <T,>(req: JsonRequest<T>) => {
      asked = req as JsonRequest<unknown>;
      return { value: answer as T, model: 'test-model' };
    };
    const out = await aiReview(store, r, 'content', ask, '/code');
    expect(asked!.task).toBe('report');
    expect(asked!.feature).toBe('review');
    expect(asked!.cwd).toBe('/code');
    const ai = out.ai.content!;
    expect(ai.model).toBe('test-model');
    expect(Object.keys(ai.verdicts)).toEqual(['c1', 'c2']);
    expect(ai.verdicts.c2).toEqual({ verdict: 'dismissed', note: 'Fine for a checkout.' });
    expect(ai.findings).toHaveLength(8);
    expect(ai.findings[0].el?.id).toBe(9);
    expect(ai.findings[0].rewrite).toEqual({ before: 'Submit', after: 'Place order' });
    expect(ai.findings[1].el).toBeUndefined();
    expect(ai.findings[1].rewrite).toBeUndefined();
    // Saved with the review.
    expect(store.get(url)?.ai.content?.summary).toBe('Clear page; the button is vague.');
  });

  it('keeps each expert’s answer when they arrive together, and a problem another expert reported only once', async () => {
    const store = new ReviewStore(tmp());
    const url = 'http://localhost:5174/#/shop';
    const r = await reviewPage(store, pageReview(url, []), ['a11y'], url);
    const button = el(7, 'Add to cart', 'src/components/ProductCard.tsx:21:7');
    r.facts.elements = [button];
    const answer = (title: string) => async <T,>(_req: JsonRequest<T>) => ({ value: { summary: title, verdicts: [], findings: [{ rule: 'heuristic', severity: 'medium', title, what: 'w', fix: 'f', element: 'e1' }] } as T, model: 'm' });
    // Both asked from the same review, before either answer was saved.
    await Promise.all([aiReview(store, r, 'ux', answer('Six identical “Add to cart” buttons are indistinguishable')), aiReview(store, r, 'a11y', answer('Six identical “Add to cart” buttons give no product context'))]);
    const saved = store.get(url)!;
    expect(Object.keys(saved.ai).sort()).toEqual(['a11y', 'ux']);
    const titles = [...(saved.ai.ux?.findings ?? []), ...(saved.ai.a11y?.findings ?? [])].map((f) => f.title);
    expect(titles).toHaveLength(1);
    // A different problem about the same button stays.
    await aiReview(store, saved, 'content', answer('Say which product each button adds to the cart'));
    expect(store.get(url)?.ai.content?.findings).toHaveLength(1);
  });
});

describe('the experts as Agent Skills', () => {
  it('have valid SKILL.md frontmatter: a name matching the folder and a quoted description', () => {
    for (const id of ['seo', 'content', 'ux', 'a11y'] as const) {
      const text = skillFile(id);
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
      const name = /^name: (.+)$/m.exec(front)?.[1];
      expect(name).toBe(EXPERTS[id].skill);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(name!.length).toBeLessThanOrEqual(64);
      const description = JSON.parse(/^description: (".*")$/m.exec(front)?.[1] ?? 'null') as string;
      expect(description).toBe(EXPERTS[id].description);
      expect(description.length).toBeLessThanOrEqual(1024);
      expect(text).toContain('## How to report');
    }
  });

  it('are written for every coding agent, and for Claude Code when the app uses it', () => {
    const root = tmp();
    const list = [{ id: 'seo' as const, text: skillFile('seo') }];
    expect(installSkills(root, list)).toEqual({ written: ['.agents/skills/seo-audit/SKILL.md'], kept: [] });
    fs.mkdirSync(path.join(root, '.claude'));
    expect(installSkills(root, list)).toEqual({ written: ['.agents/skills/seo-audit/SKILL.md', '.claude/skills/seo-audit/SKILL.md'], kept: [] });
    expect(fs.readFileSync(path.join(root, '.claude/skills/seo-audit/SKILL.md'), 'utf8')).toBe(skillFile('seo'));
  });

  it('update what the studio wrote before, and never replace a skill of the person’s own', () => {
    const root = tmp();
    const own = '---\nname: seo-audit\ndescription: Our team’s SEO checklist\n---\n\nOur rules.\n';
    const older = skillFile('seo').replace('# SEO review', '# SEO review (an older edition)');
    fs.mkdirSync(path.join(root, '.claude/skills/seo-audit'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude/skills/seo-audit/SKILL.md'), own);
    fs.mkdirSync(path.join(root, '.agents/skills/seo-audit'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents/skills/seo-audit/SKILL.md'), older);
    const list = [{ id: 'seo' as const, text: skillFile('seo') }];
    expect(installSkills(root, list)).toEqual({ written: ['.agents/skills/seo-audit/SKILL.md'], kept: ['.claude/skills/seo-audit/SKILL.md'] });
    expect(fs.readFileSync(path.join(root, '.claude/skills/seo-audit/SKILL.md'), 'utf8')).toBe(own);
    expect(fs.readFileSync(path.join(root, '.agents/skills/seo-audit/SKILL.md'), 'utf8')).toBe(skillFile('seo'));
    expect(skillsAnswer({ written: ['.agents/skills/seo-audit/SKILL.md'], kept: ['.claude/skills/seo-audit/SKILL.md'] })).toBe(
      'Left .claude/skills/seo-audit/SKILL.md as it is: a skill of that name is already there and the studio didn’t write it. Rename or move it to add the studio’s.',
    );
    expect(skillsAnswer({ written: ['a'], kept: [] })).toBeUndefined();
  });
});
