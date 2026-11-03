/**
 * Checks a page against the rules the studio's experts stand on: Google
 * Search Central for SEO, WCAG 2.2 (through axe-core) for accessibility,
 * GOV.UK, web.dev and W3C guidance for content, forms and right-to-left text.
 * Only what a rule backs is reported, with the elements it is about; judging
 * quality (is this title good?) is left to the AI review.
 *
 * Runs only when asked, inside the page, in short steps with a pause between
 * them: the page and the studio (same thread) stay responsive, and the studio
 * shows how far it has got. Long runs of like items (rows, cards) are checked
 * by their first few.
 */
import type { CheckSeverity, ElementInfo, ExpertId, PageCheck, PageFacts, PageReview } from '../protocol';
import { collapse, describe, isVisible } from './dom';
import { own } from './own';

const G = 'https://developers.google.com/search/docs';

/** Lighthouse's link-text list (English), and the Arabic equivalents. */
const VAGUE_LINKS = new Set(['click here', 'click this', 'go', 'here', 'information', 'learn more', 'more', 'more info', 'more information', 'right here', 'read more', 'see more', 'start', 'this', 'اضغط هنا', 'انقر هنا', 'هنا', 'المزيد', 'اقرأ المزيد', 'اعرف المزيد']);
/** Button labels that don't say what happens (GOV.UK, web.dev, Vercel). */
const VAGUE_BUTTONS = new Set(['continue', 'submit', 'ok', 'okay', 'next', 'click here', 'send', 'go', 'yes', 'no', 'إرسال', 'ارسال', 'متابعة', 'موافق', 'التالي', 'تم']);
/** Error wording GOV.UK's guidance warns against. */
const VAGUE_ERRORS = /^(this field is required|required|an error (has )?occurred|something went wrong|invalid( input| value)?|error|oops[.!]*|please (try again|enter a valid .*)|حدث خطأ|هذا الحقل مطلوب|غير صالح)\.?$/i;

const ARABIC = /[؀-ۿ]/g;
const LATIN = /[A-Za-z]/g;

function sample(els: Element[], n = 6): ElementInfo[] {
  return els.slice(0, n).map((el) => describe(el));
}

function html(el: Element, max = 220): string {
  const outer = el.outerHTML.replace(/\s+/g, ' ');
  if (outer.length <= max) return outer;
  const open = outer.slice(0, outer.indexOf('>') + 1);
  return open.length <= max ? `${open}…` : `${open.slice(0, max - 1)}…`;
}

function check(c: Omit<PageCheck, 'els' | 'html'>, els: Element[] = []): PageCheck {
  return els.length ? { ...c, count: c.count ?? els.length, els: sample(els), html: els.slice(0, 3).map((e) => html(e)) } : c;
}

const meta = (name: string) => document.querySelector(`meta[name="${name}" i]`)?.getAttribute('content') ?? null;

function textOf(el: Element): string {
  return collapse((el as HTMLElement).innerText ?? el.textContent ?? '', 400);
}

function isAbsolute(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/** Visible, rendered, not inside the studio's own recorder button. */
function shown(el: Element): boolean {
  return !el.closest('saywright-recorder') && isVisible(el);
}

// ── readability ──────────────────────────────────────────────────────────

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Flesch Reading Ease and Flesch–Kincaid grade for English; sentence length for Arabic (its formulas need diacritics web text rarely has). */
export function readability(text: string): PageFacts['readability'] {
  const ar = (text.match(ARABIC) ?? []).length;
  const en = (text.match(LATIN) ?? []).length;
  const sentences = text.split(/[.!?؟。]+(?:\s|$)|\n+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 3);
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length < 100 || !sentences.length) return null;
  const perSentence = words.length / sentences.length;
  if (ar > en) return { lang: 'ar', ease: null, grade: null, sentence: Math.round(perSentence * 10) / 10 };
  const syl = words.reduce((n, w) => n + syllables(w), 0) / words.length;
  return {
    lang: 'en',
    ease: Math.round((206.835 - 1.015 * perSentence - 84.6 * syl) * 10) / 10,
    grade: Math.round((0.39 * perSentence + 11.8 * syl - 15.59) * 10) / 10,
    sentence: Math.round(perSentence * 10) / 10,
  };
}

// ── facts ────────────────────────────────────────────────────────────────

let lcp: number | null = null;
let cls = 0;
let watching = false;

/** Start listening for the page's paint and layout-shift entries (buffered: earlier ones count too). */
export function watchVitals(): void {
  if (watching || typeof PerformanceObserver === 'undefined') return;
  watching = true;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) lcp = Math.round(e.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* not supported here */
  }
}

function facts(): PageFacts {
  const main = document.querySelector('main, [role="main"]') ?? document.body;
  const text = ((main as HTMLElement).innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  const here = location.origin;
  let internal = 0;
  let external = 0;
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    try {
      if (new URL((a as HTMLAnchorElement).href).origin === here) internal++;
      else external++;
    } catch {
      /* not a URL */
    }
  }
  const og: Record<string, string> = {};
  for (const m of Array.from(document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]'))) {
    const k = m.getAttribute('property') ?? m.getAttribute('name');
    if (k) og[k] = m.getAttribute('content') ?? '';
  }
  const jsonLd: string[] = [];
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(s.textContent ?? '');
      for (const d of [data, ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])].flat()) if (d?.['@type']) jsonLd.push(String(d['@type']));
    } catch {
      jsonLd.push('(invalid JSON)');
    }
  }
  const fields = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')).filter(shown) as HTMLInputElement[];
  return {
    url: location.href,
    title: document.title,
    description: meta('description'),
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
    robots: meta('robots'),
    lang: document.documentElement.getAttribute('lang'),
    dir: document.documentElement.getAttribute('dir'),
    viewport: meta('viewport'),
    headings: Array.from(document.querySelectorAll('h1, h2, h3, h4'))
      .filter(shown)
      .slice(0, 40)
      .map((h) => ({ level: Number(h.tagName[1]), text: collapse(h.textContent, 100) })),
    og,
    jsonLd,
    words: text.split(/\s+/).filter(Boolean).length,
    text: text.slice(0, 4000),
    links: { internal, external },
    images: document.images.length,
    forms: fields.slice(0, 30).map((f) => ({ label: fieldLabel(f), type: f.type || f.tagName.toLowerCase(), autocomplete: f.getAttribute('autocomplete'), required: f.required })),
    buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type=submit]'))
      .filter(shown)
      .map((b) => collapse((b as HTMLElement).innerText || b.getAttribute('aria-label') || (b as HTMLInputElement).value || '', 40))
      .filter(Boolean)
      .slice(0, 30),
    lcp,
    cls: watching ? Math.round(cls * 1000) / 1000 : null,
    readability: readability(text),
    elements: keyElements(),
    landmarks: landmarks(),
    live: liveRegions(),
    linkTargets: linkTargets(),
  };
}

// What the AI experts need to see before saying something is missing.

const LANDMARKS: Record<string, string> = { header: 'banner', nav: 'navigation', main: 'main', aside: 'complementary', footer: 'contentinfo', search: 'search', section: 'region', form: 'form' };

/** The page's landmarks, as a screen reader lists them, with their names. */
function landmarks(): { role: string; name: string }[] {
  const sel = 'header, nav, main, aside, footer, search, section[aria-label], section[aria-labelledby], form[aria-label], form[aria-labelledby], [role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"], [role="search"], [role="region"], [role="form"]';
  return Array.from(document.querySelectorAll(sel))
    .filter((el) => shown(el) && (el.hasAttribute('role') || !/^(header|footer)$/i.test(el.tagName) || !el.parentElement?.closest('article, aside, main, nav, section')))
    .slice(0, 20)
    .map((el) => {
      // A landmark is named by aria-label or aria-labelledby, never by its content.
      const byIds = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''));
      return { role: el.getAttribute('role') ?? LANDMARKS[el.tagName.toLowerCase()] ?? el.tagName.toLowerCase(), name: collapse(el.getAttribute('aria-label') ?? byIds.join(' '), 40) };
    });
}

/** Where the page announces changes to screen readers (status, alert, aria-live), and what each says now. */
function liveRegions(): { role: string; text: string }[] {
  return Array.from(document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"], [role="timer"], output'))
    .filter((el) => !el.closest('saywright-recorder') && el.getAttribute('aria-live') !== 'off')
    .slice(0, 12)
    .map((el) => ({ role: el.getAttribute('role') ?? (el.hasAttribute('aria-live') ? `aria-live=${el.getAttribute('aria-live')}` : 'status'), text: collapse(textOf(el), 60) }));
}

/** Where the page's links go, as written (a #/route stays one), with their text. */
function linkTargets(): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')).filter(shown)) {
    const link = { text: collapse((a as HTMLElement).innerText || a.getAttribute('aria-label') || '', 40), href: (a.getAttribute('href') ?? '').slice(0, 120) };
    if (!out.some((l) => l.text === link.text && l.href === link.href)) out.push(link);
    if (out.length >= 25) break;
  }
  return out;
}

/** What a reviewer would point at: the main headings, the first actions in view, the form fields. */
function keyElements(): ElementInfo[] {
  const inView = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight * 1.5;
  };
  const pick = (sel: string, n: number, view = false) => Array.from(document.querySelectorAll(sel)).filter((el) => shown(el) && (!view || inView(el))).slice(0, n);
  const els = [...pick('h1', 2), ...pick('h2', 4), ...pick('button, [role="button"], input[type=submit]', 6, true), ...pick('main a[href], [role="main"] a[href]', 4, true), ...pick('input:not([type=hidden]), select, textarea', 6)];
  return [...new Set(els)].slice(0, 20).map((el) => describe(el));
}

function fieldLabel(f: HTMLInputElement): string {
  const byIds = (f.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .map((id) => (id ? document.getElementById(id)?.textContent : '') ?? '')
    .join(' ')
    .trim();
  const byFor = f.id ? document.querySelector(`label[for="${CSS.escape(f.id)}"]`)?.textContent : null;
  return collapse(byIds || f.getAttribute('aria-label') || byFor || f.closest('label')?.textContent || f.getAttribute('title') || '', 60);
}

// ── SEO ──────────────────────────────────────────────────────────────────

function seo(f: PageFacts): PageCheck[] {
  const out: PageCheck[] = [];
  const add = (c: Omit<PageCheck, 'expert' | 'els' | 'html'>, els?: Element[]) => out.push(check({ ...c, expert: 'seo' }, els));

  if (!f.title.trim()) add({ rule: 'SEO-16', severity: 'high', title: 'The page has no title', what: 'The <title> is missing or empty, so search results and browser tabs have nothing to show.', fix: 'Give each page its own descriptive <title> (and update it on every route of a single-page app).', source: `${G}/appearance/title-link`, wcag: ['2.4.2'] });
  else if (/^(home|untitled|index|document|react app|vite \+ react|new page)$/i.test(f.title.trim())) add({ rule: 'SEO-17', severity: 'medium', title: 'The title is a placeholder', what: `The title is “${f.title}”, which says nothing about the page.`, fix: 'Write a unique title that says what the page is, with the brand short at the end.', source: `${G}/appearance/title-link` });
  else if (f.title.length > 70) add({ rule: 'SEO-18', severity: 'info', title: 'The title may be cut off in results', what: `The title is ${f.title.length} characters; Google truncates title links to fit the device width.`, fix: 'Put what matters first. There is no length limit, so only trim if the start doesn’t say what the page is.', source: `${G}/appearance/title-link` });

  if (!f.description) add({ rule: 'SEO-19', severity: 'low', title: 'No meta description', what: 'Without one, Google builds the snippet from the page text.', fix: 'Add a page-specific summary in <meta name="description">: what the reader gets here, not a list of keywords.', source: `${G}/appearance/snippet` });

  const robots = `${f.robots ?? ''} ${meta('googlebot') ?? ''}`.toLowerCase();
  if (/\b(noindex|none)\b/.test(robots)) add({ rule: 'SEO-05', severity: 'blocker', title: 'The page asks not to be indexed', what: `The robots meta tag says “${robots.trim()}”, so it won’t appear in search.`, fix: 'Remove noindex from pages meant to rank (keep it for private or duplicate pages).', source: `${G}/crawling-indexing/robots-meta-tag` });
  if (/\b(nosnippet|max-snippet:\s*0)\b/.test(robots)) add({ rule: 'SEO-07', severity: 'medium', title: 'Snippets are turned off', what: 'nosnippet / max-snippet:0 removes the text snippet and keeps the page out of AI Overviews as a direct source.', fix: 'Remove it unless that is the intent.', source: `${G}/appearance/ai-features` });

  const canon = Array.from(document.querySelectorAll('link[rel="canonical"]'));
  const bodyCanon = canon.filter((l) => !l.closest('head'));
  if (canon.length > 1) add({ rule: 'SEO-13', severity: 'high', title: 'More than one canonical', what: `${canon.length} rel=canonical links: Google may ignore them all.`, fix: 'Keep exactly one, in <head>, with an absolute URL.', source: `${G}/crawling-indexing/consolidate-duplicate-urls` }, canon);
  else if (canon.length === 1) {
    const href = canon[0].getAttribute('href') ?? '';
    if (bodyCanon.length) add({ rule: 'SEO-13', severity: 'high', title: 'The canonical is outside <head>', what: 'rel=canonical only counts in the <head>.', fix: 'Move it into <head>.', source: `${G}/crawling-indexing/consolidate-duplicate-urls` }, canon);
    else if (!isAbsolute(href)) add({ rule: 'SEO-13', severity: 'low', title: 'The canonical URL is relative', what: `rel=canonical is “${href}”.`, fix: 'Use the absolute URL (https://…).', source: `${G}/crawling-indexing/consolidate-duplicate-urls` }, canon);
    if (['hreflang', 'lang', 'media', 'type'].some((a) => canon[0].hasAttribute(a))) add({ rule: 'SEO-13', severity: 'high', title: 'The canonical carries attributes that void it', what: 'A canonical with hreflang, lang, media or type isn’t used for canonicalization.', fix: 'Remove those attributes from the canonical link.', source: `${G}/crawling-indexing/consolidate-duplicate-urls` }, canon);
  }

  const h1 = Array.from(document.querySelectorAll('h1, [role="heading"][aria-level="1"]')).filter(shown);
  if (!h1.length && !f.headings.length) add({ rule: 'SEO-20', severity: 'low', title: 'No main heading', what: 'The page has no visible headings, so its topic isn’t stated in its structure.', fix: 'Add a descriptive main heading (an <h1>). More than one is fine.', source: `${G}/fundamentals/seo-starter-guide` });

  if (!f.viewport || !/width\s*=\s*device-width/i.test(f.viewport)) add({ rule: 'SEO-28', severity: 'high', title: 'No mobile viewport', what: f.viewport ? `The viewport is “${f.viewport}”.` : 'There is no <meta name="viewport">: phones get a zoomed-out desktop page.', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', source: `${G}/crawling-indexing/mobile/mobile-sites-mobile-first-indexing` });

  // Links Google can't follow.
  const anchors = Array.from(document.querySelectorAll('a')).filter(shown) as HTMLAnchorElement[];
  const deadLinks = anchors.filter((a) => {
    const href = a.getAttribute('href');
    return href === null ? a.hasAttribute('onclick') || a.getAttribute('role') === 'link' || !!a.textContent?.trim() : href === '' || /^javascript:/i.test(href) || href === '#';
  });
  if (deadLinks.length) add({ rule: 'SEO-22', severity: 'medium', title: 'Links Google can’t follow', what: `${deadLinks.length} link${deadLinks.length > 1 ? 's have' : ' has'} no real href (missing, empty, “#” or javascript:).`, fix: 'Use <a href="/real/path"> for navigation, and a <button> for actions.', source: `${G}/crawling-indexing/links-crawlable` }, deadLinks);
  const vague = anchors.filter((a) => VAGUE_LINKS.has(collapse(a.innerText || a.textContent, 40).toLowerCase().replace(/[.…!]+$/, '')) && !a.getAttribute('aria-label'));
  if (vague.length) add({ rule: 'SEO-23', severity: 'low', title: 'Link text that says nothing', what: `${vague.length} link${vague.length > 1 ? 's say' : ' says'} things like “${collapse(vague[0].innerText, 30)}”.`, fix: 'Say where the link goes: “Read the returns policy”, not “Read more”.', source: `${G}/crawling-indexing/links-crawlable`, wcag: ['2.4.4'] }, vague);
  // With its evidence: this page's own #/ address, and the links that go to #/ routes.
  const hashed = anchors.filter((a) => /^#!?\//.test(a.getAttribute('href') ?? ''));
  const routes = Array.from(new Set(hashed.map((a) => a.getAttribute('href')))).slice(0, 4).join(', ');
  const here = /^#!?\//.test(location.hash) ? `This page’s address ends in ${location.hash}` : '';
  if (here || hashed.length) add({ rule: 'SEO-29', severity: 'high', title: 'Pages addressed by #fragments', what: `${here}${here && routes ? ', and its' : routes ? 'This page’s' : ''}${routes ? ` links go to ${routes}` : ''}. Routes like /#/about are one URL to Google; their content isn’t indexed separately.`, fix: 'Use the History API (path routes, e.g. /about) instead of hash routes.', source: `${G}/crawling-indexing/javascript/javascript-seo-basics` }, hashed);

  // Images: indexable and described.
  const imgs = Array.from(document.images).filter(shown);
  const noAlt = imgs.filter((i) => !i.hasAttribute('alt'));
  if (noAlt.length) add({ rule: 'SEO-21', severity: 'medium', title: 'Images without alt text', what: `${noAlt.length} image${noAlt.length > 1 ? 's have' : ' has'} no alt attribute.`, fix: 'Describe what each image shows in context (alt=""for purely decorative ones).', source: `${G}/appearance/google-images`, wcag: ['1.1.1'] }, noAlt);
  const bigBg = Array.from(document.querySelectorAll('main *, [role="main"] *'))
    .filter((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || !/url\(/.test(bg) || /gradient/.test(bg)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 300 && r.height >= 200 && shown(el);
    })
    .slice(0, 6);
  if (bigBg.length) add({ rule: 'SEO-21', severity: 'info', title: 'Content images set as CSS backgrounds', what: `${bigBg.length} large image${bigBg.length > 1 ? 's are' : ' is'} CSS background${bigBg.length > 1 ? 's' : ''}; Google doesn’t index those.`, fix: 'If the image is content (a product, a photo), use <img> or <picture> with alt text.', source: `${G}/appearance/google-images` }, bigBg);

  // Social cards.
  const missingOg = ['og:title', 'og:type', 'og:image', 'og:url'].filter((k) => !f.og[k]);
  if (missingOg.length) add({ rule: 'SEO-31', severity: 'low', title: 'Incomplete link preview (Open Graph)', what: `Missing ${missingOg.join(', ')}: shared links show a bare preview.`, fix: 'Add og:title, og:type, og:image (absolute URL) and og:url (the canonical).', source: 'https://ogp.me' });
  else if (f.og['og:image'] && !isAbsolute(f.og['og:image'])) add({ rule: 'SEO-31', severity: 'low', title: 'The preview image URL is relative', what: `og:image is “${f.og['og:image']}”.`, fix: 'Use an absolute URL.', source: 'https://ogp.me' });

  // Structured data.
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? '');
    } catch (err) {
      add({ rule: 'SEO-37', severity: 'high', title: 'Structured data that doesn’t parse', what: `A JSON-LD block is invalid JSON (${err instanceof Error ? err.message.slice(0, 80) : 'parse error'}).`, fix: 'Fix the JSON; Google ignores the whole block otherwise.', source: `${G}/appearance/structured-data/intro-structured-data` });
      continue;
    }
    const items = [data, ...(Array.isArray((data as { '@graph'?: unknown[] })?.['@graph']) ? (data as { '@graph': unknown[] })['@graph'] : [])].flat() as Record<string, unknown>[];
    for (const d of items) {
      if (!d || typeof d !== 'object' || !d['@type']) continue;
      const type = String(d['@type']);
      const need = (keys: string[], anyOf = false) => (anyOf ? keys.some((k) => d[k] != null) : keys.every((k) => d[k] != null));
      if (type === 'Product' && !(d.name && need(['offers', 'review', 'aggregateRating'], true))) add({ rule: 'SEO-38', severity: 'medium', title: 'Product markup missing required fields', what: 'Product needs a name and at least one of offers, review or aggregateRating for a product snippet.', fix: 'Add the missing fields, matching what the page shows.', source: `${G}/appearance/structured-data/product-snippet` });
      if (type === 'BreadcrumbList') {
        const list = Array.isArray(d.itemListElement) ? d.itemListElement : [];
        if (list.length < 2 || list.some((li: Record<string, unknown>) => li?.position == null || li?.name == null)) add({ rule: 'SEO-38', severity: 'medium', title: 'Breadcrumb markup incomplete', what: 'BreadcrumbList needs at least two items, each with position and name.', fix: 'Complete itemListElement.', source: `${G}/appearance/structured-data/breadcrumb` });
      }
      if (type === 'LocalBusiness' && !need(['name', 'address'])) add({ rule: 'SEO-38', severity: 'medium', title: 'LocalBusiness markup missing name or address', what: 'Both are required.', fix: 'Add name and a PostalAddress.', source: `${G}/appearance/structured-data/local-business` });
      if (type === 'FAQPage' || type === 'HowTo') add({ rule: 'SEO-40', severity: 'info', title: `${type} rich results are retired`, what: `Google no longer shows ${type} rich results; the markup is harmless.`, fix: 'No change needed; don’t expect a rich result from it.', source: 'https://developers.google.com/search/updates' });
    }
  }

  // hreflang syntax.
  for (const l of Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]'))) {
    const code = l.getAttribute('hreflang') ?? '';
    const href = l.getAttribute('href') ?? '';
    if (code !== 'x-default' && !/^[a-z]{2,3}(-[A-Za-z]{2}|-[A-Za-z]{4}(-[A-Za-z]{2})?)?$/i.test(code)) add({ rule: 'SEO-25', severity: 'high', title: 'Invalid hreflang code', what: `hreflang="${code}" isn’t a language (and optional region) code.`, fix: 'Use ISO 639-1 language codes, optionally with an ISO 3166-1 region: “ar”, “ar-EG”, “en-GB”.', source: `${G}/specialty/international/localized-versions` }, [l]);
    else if (!isAbsolute(href)) add({ rule: 'SEO-25', severity: 'medium', title: 'hreflang alternate with a relative URL', what: `${code} points at “${href}”.`, fix: 'Use fully qualified URLs.', source: `${G}/specialty/international/localized-versions` }, [l]);
  }

  // URL hygiene.
  const path = decodeURIComponent(location.pathname);
  if (/_/.test(path)) add({ rule: 'SEO-30', severity: 'info', title: 'Underscores in the URL', what: `“${path}” uses underscores.`, fix: 'Separate words in URLs with hyphens.', source: `${G}/crawling-indexing/url-structure` });

  // Core Web Vitals, as measured here. A dev server loads unbundled code, so its paint time says little about production.
  const dev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (f.lcp != null && f.lcp > 2500)
    add({
      rule: 'SEO-34',
      severity: dev ? 'info' : f.lcp > 4000 ? 'high' : 'medium',
      title: 'Slow largest paint (lab)',
      what: `LCP here was ${(f.lcp / 1000).toFixed(1)} s (good is 2.5 s or less). This is this browser, not real users${dev ? ', on a dev server: measure the production build' : ''}.`,
      fix: 'Load the main image or text sooner: preload it, serve it smaller, and avoid render-blocking scripts.',
      source: 'https://web.dev/articles/vitals',
    });
  if (f.cls != null && f.cls > 0.1) add({ rule: 'SEO-34', severity: f.cls > 0.25 ? 'high' : 'medium', title: 'Layout shifts (lab)', what: `CLS here was ${f.cls} (good is 0.1 or less).`, fix: 'Give images and embeds width and height, and reserve space for late content.', source: 'https://web.dev/articles/vitals' });
  return out;
}

// ── content ──────────────────────────────────────────────────────────────

function content(f: PageFacts): PageCheck[] {
  const out: PageCheck[] = [];
  const add = (c: Omit<PageCheck, 'expert' | 'els' | 'html'>, els?: Element[]) => out.push(check({ ...c, expert: 'content' }, els));
  const r = f.readability;
  if (r?.lang === 'en' && r.grade != null && r.grade > 12) add({ rule: 'CNT-01', severity: 'medium', title: 'Hard to read', what: `Reading grade ${r.grade} (Flesch–Kincaid), ease ${r.ease}. Aim for grade 9 or less on public pages.`, fix: 'Shorter sentences, everyday words, one idea per sentence.', source: 'https://www.w3.org/WAI/WCAG22/Understanding/reading-level', wcag: ['3.1.5'] });
  else if (r?.lang === 'en' && r.grade != null && r.grade > 9) add({ rule: 'CNT-01', severity: 'low', title: 'Reading level above grade 9', what: `Reading grade ${r.grade}, ease ${r.ease}.`, fix: 'Shorten the longest sentences and replace jargon.', source: 'https://www.w3.org/WAI/WCAG22/Understanding/reading-level', wcag: ['3.1.5'] });
  if (r && r.sentence > 25) add({ rule: 'CNT-02', severity: 'low', title: 'Long sentences', what: `Sentences average ${r.sentence} words.`, fix: 'Keep sentences short: one point each.', source: 'https://www.w3.org/TR/coga-usable/#keep-text-succinct' });
  const longParas = Array.from(document.querySelectorAll('p')).filter((p) => shown(p) && (p.textContent ?? '').split(/\s+/).length > 120);
  if (longParas.length) add({ rule: 'CNT-02', severity: 'low', title: 'Long paragraphs', what: `${longParas.length} paragraph${longParas.length > 1 ? 's run' : ' runs'} past 120 words.`, fix: 'One topic per paragraph, with the point first; break the rest up or use a list.', source: 'https://www.w3.org/TR/coga-usable/#keep-text-succinct' }, longParas);

  const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type=submit], input[type=button]')).filter(shown);
  const vagueButtons = buttons.filter((b) => VAGUE_BUTTONS.has(collapse((b as HTMLElement).innerText || (b as HTMLInputElement).value || '', 30).toLowerCase().replace(/[.…!→›>]+$/, '').trim()));
  if (vagueButtons.length) add({ rule: 'CNT-06', severity: 'low', title: 'Buttons that don’t say what they do', what: `${vagueButtons.length} button${vagueButtons.length > 1 ? 's say' : ' says'} “${collapse((vagueButtons[0] as HTMLElement).innerText || (vagueButtons[0] as HTMLInputElement).value, 20)}”.`, fix: 'Name the action: verb and object (“Pay $98”, “Save address”).', source: 'https://design-system.service.gov.uk/components/button/' }, vagueButtons);

  const errors = Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], .error, .error-message, [class*="error" i]')).filter((e) => shown(e) && VAGUE_ERRORS.test(textOf(e)));
  if (errors.length) add({ rule: 'CNT-07', severity: 'medium', title: 'Error messages that don’t help', what: `${errors.length} error${errors.length > 1 ? 's say' : ' says'} “${textOf(errors[0]).slice(0, 40)}”.`, fix: 'Say what went wrong and how to fix it, in the field’s own words (“Enter an email address in the format name@example.com”).', source: 'https://design-system.service.gov.uk/components/error-message/', wcag: ['3.3.1', '3.3.3'] }, errors);

  // Right to left.
  const bodyText = f.text;
  const ar = (bodyText.match(ARABIC) ?? []).length;
  const latin = (bodyText.match(LATIN) ?? []).length;
  const arabicPage = ar > latin && ar > 40;
  const root = document.documentElement;
  if (arabicPage) {
    if (!/^ar\b/i.test(f.lang ?? '')) add({ rule: 'RTL-01', severity: 'high', title: 'Arabic page not marked as Arabic', what: `The page is mostly Arabic but <html lang> is “${f.lang ?? 'missing'}”.`, fix: 'Set <html lang="ar" dir="rtl">.', source: 'https://www.w3.org/International/questions/qa-html-dir', wcag: ['3.1.1'] });
    if (f.dir !== 'rtl') {
      const cssRtl = getComputedStyle(root).direction === 'rtl' || getComputedStyle(document.body).direction === 'rtl';
      add({ rule: cssRtl ? 'RTL-02' : 'RTL-01', severity: 'high', title: cssRtl ? 'Direction set in CSS, not markup' : 'Arabic page without dir="rtl"', what: cssRtl ? 'direction: rtl comes from CSS; the base direction must be in the markup.' : '<html> has no dir="rtl", so punctuation and layout fall in the wrong place.', fix: 'Put dir="rtl" on <html> (lang alone doesn’t set the direction).', source: 'https://www.w3.org/International/questions/qa-html-dir' });
    }
    if (/^[A-Za-z]/.test(f.title) && !f.title.startsWith('‏')) add({ rule: 'RTL-06', severity: 'info', title: 'Title starts with a Latin word', what: `In a right-to-left page, “${f.title.slice(0, 30)}” may show reversed in some places.`, fix: 'Start the title with &rlm; (U+200F).', source: 'https://www.w3.org/International/questions/qa-html-dir' });
    const western = /[0-9]/.test(bodyText);
    const eastern = /[٠-٩]/.test(bodyText);
    if (western && eastern) add({ rule: 'RTL-08', severity: 'low', title: 'Two digit systems on one page', what: 'Both 0–9 and ٠–٩ digits appear.', fix: 'Pick one for the market (Arabic-Indic for Egypt, Saudi Arabia, Iraq; European digits for the Maghreb) and use it throughout.', source: 'https://www.w3.org/TR/alreq/' });
    const spaced = Array.from(document.querySelectorAll('h1, h2, h3, p, li, a, button, span, label'))
      .filter((el) => shown(el) && /[؀-ۿ]/.test(el.textContent ?? '') && !['normal', '0px'].includes(getComputedStyle(el).letterSpacing))
      .slice(0, 6);
    if (spaced.length) add({ rule: 'RTL-09', severity: 'medium', title: 'Letter-spacing on Arabic text', what: 'Spacing Arabic letters breaks their joins.', fix: 'Set letter-spacing: normal for Arabic text (use :lang(ar)).', source: 'https://www.w3.org/TR/alreq/' }, spaced);
  }
  return out;
}

// ── UX ───────────────────────────────────────────────────────────────────

const CLICKABLE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

function ux(f: PageFacts): PageCheck[] {
  const out: PageCheck[] = [];
  const add = (c: Omit<PageCheck, 'expert' | 'els' | 'html'>, els?: Element[]) => out.push(check({ ...c, expert: 'ux' }, els));

  // Targets under 24×24 with a neighbour closer than 24 px (WCAG 2.5.8); links inside text are exempt.
  const targets = Array.from(document.querySelectorAll(CLICKABLE)).filter((el) => shown(el) && !el.closest('saywright-recorder'));
  const rects = targets.map((el) => el.getBoundingClientRect());
  const small = targets.filter((el, i) => {
    const r = rects[i];
    if (r.width >= 24 && r.height >= 24) return false;
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return false;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return rects.some((o, j) => j !== i && !el.contains(targets[j]) && !targets[j].contains(el) && Math.hypot(Math.max(o.left - cx, 0, cx - o.right), Math.max(o.top - cy, 0, cy - o.bottom)) < 12);
  });
  if (small.length) add({ rule: 'UX-01', severity: 'medium', title: 'Small, crowded tap targets', what: `${small.length} control${small.length > 1 ? 's are' : ' is'} smaller than 24×24 px with a neighbour too close.`, fix: 'Make targets at least 24×24 px (44×44 for touch-first screens), or space them apart.', source: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum', wcag: ['2.5.8'] }, small);

  // Clickable things that aren't controls.
  const fake = Array.from(document.querySelectorAll('div[onclick], span[onclick], li[onclick], div[style*="cursor: pointer" i], span[style*="cursor: pointer" i]')).filter((el) => shown(el) && !el.closest(CLICKABLE) && !el.getAttribute('role'));
  if (fake.length) add({ rule: 'UX-06', severity: 'medium', title: 'Clickable things that aren’t buttons or links', what: `${fake.length} element${fake.length > 1 ? 's react' : ' reacts'} to clicks without being a control: keyboards and screen readers can’t use ${fake.length > 1 ? 'them' : 'it'}.`, fix: 'Use <button> for actions and <a href> for navigation.', source: 'https://vercel.com/design/guidelines', wcag: ['2.1.1', '4.1.2'] }, fake);

  // Fields: labels, input types, autocomplete.
  const fields = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, select')).filter(shown) as HTMLInputElement[];
  const placeholderOnly = fields.filter((i) => i.placeholder && !fieldLabel(i));
  if (placeholderOnly.length) add({ rule: 'UX-07', severity: 'medium', title: 'Fields labelled only by a placeholder', what: `${placeholderOnly.length} field${placeholderOnly.length > 1 ? 's have' : ' has'} no label; the placeholder disappears as soon as someone types.`, fix: 'Add a visible <label> above each field; keep placeholders for examples, if at all.', source: 'https://design-system.service.gov.uk/components/text-input/', wcag: ['3.3.2'] }, placeholderOnly);
  const purpose: [RegExp, string, string?][] = [
    [/e-?mail/i, 'email', 'email'],
    [/phone|mobile|\btel\b/i, 'tel', 'tel'],
    [/card.?(num|no)|cc-?num|credit/i, 'cc-number'],
    [/(post|zip).?code|postal/i, 'postal-code'],
    [/first.?name|given/i, 'given-name'],
    [/last.?name|family|surname/i, 'family-name'],
    [/full.?name|^name$/i, 'name'],
    [/address|street/i, 'street-address'],
    [/city|town/i, 'address-level2'],
    [/country/i, 'country-name'],
  ];
  const missing = fields.filter((i) => {
    if (i.getAttribute('autocomplete')) return false;
    const said = [i.name, i.id, fieldLabel(i), i.placeholder].filter(Boolean);
    return purpose.some(([re]) => said.some((x) => re.test(x.trim())));
  });
  if (missing.length) add({ rule: 'UX-08', severity: 'medium', title: 'Personal-data fields without autocomplete', what: `${missing.length} field${missing.length > 1 ? 's ask' : ' asks'} for a name, email, phone, address or card with no autocomplete token, so browsers can’t fill ${missing.length > 1 ? 'them' : 'it'}.`, fix: 'Add autocomplete="email", "tel", "given-name", "street-address", "postal-code", "cc-number"… and the matching type or inputmode.', source: 'https://web.dev/articles/payment-and-address-form-best-practices', wcag: ['1.3.5'] }, missing);
  const numberCards = fields.filter((i) => i.type === 'number' && /card|cc|phone|tel|zip|post/i.test(`${i.name} ${i.id} ${fieldLabel(i)}`));
  if (numberCards.length) add({ rule: 'UX-08', severity: 'low', title: 'type="number" for a card, phone or code', what: 'Number inputs drop leading zeros and show spinners.', fix: 'Use type="text" with inputmode="numeric" (or type="tel" for phones).', source: 'https://web.dev/articles/payment-and-address-form-best-practices' }, numberCards);
  const noPaste = fields.filter((i) => /return\s+false|preventDefault/.test(i.getAttribute('onpaste') ?? ''));
  if (noPaste.length) add({ rule: 'UX-09', severity: 'high', title: 'Pasting is blocked', what: 'Blocking paste breaks password managers.', fix: 'Remove the paste handler.', source: 'https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum', wcag: ['3.3.8'] }, noPaste);

  // Zoom and motion.
  if (f.viewport && (/user-scalable\s*=\s*(no|0)/i.test(f.viewport) || /maximum-scale\s*=\s*(0?\.\d+|1(\.0+)?)\b/i.test(f.viewport))) add({ rule: 'UX-17', severity: 'high', title: 'Zoom is turned off', what: `The viewport says “${f.viewport}”.`, fix: 'Remove user-scalable=no and maximum-scale below 2.', source: 'https://www.w3.org/WAI/WCAG22/Understanding/resize-text', wcag: ['1.4.4'] });
  const overflow = document.documentElement.scrollWidth > window.innerWidth + 1 && window.innerWidth <= 480;
  if (overflow) add({ rule: 'UX-17', severity: 'medium', title: 'The page scrolls sideways on a narrow screen', what: `The page is ${document.documentElement.scrollWidth} px wide in a ${window.innerWidth} px window.`, fix: 'Let content wrap at 320 px; find the element wider than the screen (often a fixed width, a long word or a table).', source: 'https://www.w3.org/WAI/WCAG22/Understanding/reflow', wcag: ['1.4.10'] });
  const unsized = Array.from(document.images).filter((i) => shown(i) && !i.getAttribute('width') && !i.getAttribute('height') && !i.style.aspectRatio && getComputedStyle(i).aspectRatio === 'auto');
  if (unsized.length) add({ rule: 'UX-16', severity: 'low', title: 'Images without a size', what: `${unsized.length} image${unsized.length > 1 ? 's have' : ' has'} no width and height, so the page jumps while ${unsized.length > 1 ? 'they load' : 'it loads'}.`, fix: 'Set width and height (or aspect-ratio) on images.', source: 'https://web.dev/articles/optimize-cls' }, unsized);

  // Too many primary actions in view.
  const primaries = Array.from(document.querySelectorAll('button, a[href], input[type=submit]')).filter((b) => {
    if (!shown(b)) return false;
    const r = b.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    const bg = getComputedStyle(b).backgroundColor;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(bg);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return false;
    const [r1, g, b2] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const max = Math.max(r1, g, b2);
    const min = Math.min(r1, g, b2);
    // Filled, and either saturated or dark: styled as a primary action.
    return (max - min > 60 || max < 90) && r.width >= 60;
  });
  if (primaries.length > 2) add({ rule: 'UX-14', severity: 'low', title: 'Several primary-looking buttons in view', what: `${primaries.length} filled buttons compete for attention on the first screen.`, fix: 'Keep one primary action per view; make the others secondary.', source: 'https://design-system.service.gov.uk/components/button/' }, primaries);
  return out;
}

// ── accessibility (axe-core) ─────────────────────────────────────────────

interface AxeNode {
  target: string[];
  html: string;
  failureSummary?: string;
}
interface AxeResult {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  description: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeNode[];
}
type Axe = {
  run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeResult[]; incomplete: AxeResult[] }>;
  getRules: (tags?: string[]) => { ruleId: string }[];
};

async function loadAxe(src: string): Promise<Axe | null> {
  const w = window as unknown as { axe?: Axe };
  if (w.axe) return w.axe;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.dataset.saywright = 'axe';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('axe-core didn’t load'));
    document.head.appendChild(s);
  });
  return w.axe ?? null;
}

/** axe's failure summary as one line: "Fix any of the following:" headers out, the reasons joined. */
function summary(text: string | undefined): string {
  if (!text) return '';
  return collapse(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^Fix (any|all) of the following:?$/i.test(l))
      .join('; '),
    260,
  );
}

const IMPACT: Record<string, CheckSeverity> = { critical: 'blocker', serious: 'high', moderate: 'medium', minor: 'low' };

/** Plain titles for the rules met most often; axe's own wording for the rest. */
const PLAIN: Record<string, string> = {
  'color-contrast': 'Text with too little contrast',
  'color-contrast-enhanced': 'Text below enhanced contrast',
  'image-alt': 'Images without a text alternative',
  'button-name': 'Buttons without a name',
  'link-name': 'Links without a name',
  label: 'Form fields without a label',
  'select-name': 'Dropdowns without a name',
  'target-size': 'Touch targets under 24 px',
  'html-has-lang': 'Page language not set',
  'document-title': 'No page title',
  'meta-viewport': 'Zooming is blocked',
  'heading-order': 'Heading levels skip',
  'page-has-heading-one': 'No level-one heading',
  'landmark-one-main': 'No main landmark',
  region: 'Content outside landmarks',
  'nested-interactive': 'Controls inside controls',
  'scrollable-region-focusable': 'Scrolling areas keys can’t reach',
  'aria-prohibited-attr': 'ARIA attributes not allowed here',
  'aria-allowed-attr': 'ARIA attributes not allowed here',
  list: 'Lists with stray children',
  listitem: 'List items outside a list',
  'duplicate-id-aria': 'Repeated ids used by ARIA',
};

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
/** The slowest rules by far (they map where everything on the page is drawn, once for both): last, in a step of their own. */
const SLOW = ['color-contrast', 'target-size'];
/** Rules about a container and all its children (a list's items, a table's cells): they always see the whole page. */
const WHOLE = new Set(['list', 'definition-list', 'aria-required-children', 'td-headers-attr', 'th-has-data-cells', 'td-has-header']);
const RULES_PER_STEP = 12;
/** Past this many elements, setting axe up costs more than the ordinary rules: they go in one step. */
const BIG_PAGE = 3000;
/** More like items than this side by side (rows, cards, list items with the same tag and classes) are checked by their first few. */
const RUN = 30;
const KEEP = 5;

/** Let the page (and the studio) breathe between steps. */
const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * What axe checks: the whole page, but of a long run of like items only the
 * first few (their container out, the rest of its children back in). The
 * lists stay short: axe compares every element with each of them.
 */
function scope(): { context: unknown; skipped: number } {
  const include: Node[] = [document];
  const exclude: Element[] = [];
  let skipped = 0;
  const visit = (el: Element): void => {
    let cut: Set<Element> | null = null;
    if (el.childElementCount > RUN) {
      const like = new Map<string, Element[]>();
      for (const c of el.children) {
        const key = `${c.tagName} ${c.getAttribute('class') ?? ''}`;
        const run = like.get(key);
        if (run) run.push(c);
        else like.set(key, [c]);
      }
      for (const run of like.values()) {
        if (run.length <= RUN) continue;
        cut ??= new Set();
        for (const c of run.slice(KEEP)) cut.add(c);
        skipped += run.length - KEEP;
      }
    }
    if (cut) exclude.push(el);
    for (const c of el.children) {
      if (cut?.has(c)) continue;
      if (cut) include.push(c);
      visit(c);
    }
  };
  if (document.body) visit(document.body);
  if (!skipped) return { context: { exclude: [['saywright-recorder']] }, skipped };
  const recorder = document.querySelector('saywright-recorder');
  if (recorder) exclude.push(recorder);
  // `page`: still the whole page for the rules about one (skip links, landmarks).
  return { context: { include, exclude, page: true }, skipped };
}

/** One step: these rules of the tags and no others, as a run of all of them would (target-size on: it is off by default). */
function only(all: string[], step: string[]): Record<string, unknown> {
  const on = new Set(step);
  return {
    runOnly: { type: 'tag', values: TAGS },
    rules: { ...Object.fromEntries(all.filter((id) => !on.has(id)).map((id) => [id, { enabled: false }])), 'target-size': { enabled: on.has('target-size') } },
    resultTypes: ['violations', 'incomplete'],
  };
}

async function a11y(axeSrc: string | undefined, progress: (done: number) => void): Promise<PageCheck[]> {
  if (!axeSrc) return [];
  const axe = await loadAxe(axeSrc);
  if (!axe) return [];
  const all = [...new Set(axe.getRules(TAGS).map((r) => r.ruleId))];
  const { context, skipped } = own(scope);
  const rest = all.filter((id) => !SLOW.includes(id) && !(skipped && WHOLE.has(id)));
  const steps: { rules: string[]; context: unknown }[] = [];
  if (skipped) steps.push({ rules: all.filter((id) => WHOLE.has(id)), context: { exclude: [['saywright-recorder']] } });
  const perStep = document.getElementsByTagName('*').length > BIG_PAGE ? rest.length : RULES_PER_STEP;
  for (let i = 0; i < rest.length; i += perStep) steps.push({ rules: rest.slice(i, i + perStep), context });
  const slow = SLOW.filter((id) => all.includes(id));
  if (slow.length) steps.push({ rules: slow, context });
  const violations: AxeResult[] = [];
  const incomplete: AxeResult[] = [];
  for (const [i, step] of steps.entries()) {
    await pause();
    const res = await own(() => axe.run(step.context, only(all, step.rules)));
    violations.push(...res.violations);
    incomplete.push(...res.incomplete);
    progress((i + 1) / steps.length);
  }
  // In axe's own order, as one run would give them.
  const order = new Map(all.map((id, i) => [id, i]));
  const byRule = (a: AxeResult, b: AxeResult) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  const toCheck = (r: AxeResult, incomplete: boolean): PageCheck => {
    const els = r.nodes.map((n) => document.querySelector(n.target[0])).filter((e): e is Element => !!e);
    // wcag143 is 1.4.3, wcag2411 is 2.4.11.
    const wcag = r.tags.filter((t) => /^wcag\d{3,5}$/.test(t)).map((t) => `${t[4]}.${t[5]}.${t.slice(6)}`);
    return {
      rule: `axe:${r.id}`,
      expert: 'a11y',
      severity: incomplete ? 'info' : (IMPACT[r.impact ?? 'minor'] ?? 'low'),
      title: incomplete ? `Check by hand: ${PLAIN[r.id] ?? r.help}` : (PLAIN[r.id] ?? r.help),
      // The evidence: how many, and what axe saw on the first one. The fix: what the rule asks for.
      what: `${PLAIN[r.id] ? `${r.help}. ` : ''}${r.nodes.length} element${r.nodes.length === 1 ? '' : 's'}${summary(r.nodes[0]?.failureSummary) ? `: ${summary(r.nodes[0]?.failureSummary)}` : '.'}`,
      fix: r.description,
      count: r.nodes.length,
      els: sample(els),
      html: r.nodes.slice(0, 3).map((n) => collapse(n.html, 220)),
      wcag: wcag.length ? wcag : undefined,
      source: r.helpUrl,
    };
  };
  const checks = [...violations.sort(byRule).map((r) => toCheck(r, false)), ...incomplete.sort(byRule).filter((r) => r.nodes.length).slice(0, 12).map((r) => toCheck(r, true))];
  if (skipped)
    checks.push({
      rule: 'axe:sampled',
      expert: 'a11y',
      severity: 'info',
      title: 'Long lists checked by their first items',
      what: `${skipped.toLocaleString('en')} items that repeat the ones before them (rows, cards) weren’t checked one by one, so counts above can be lower than on the page.`,
      fix: 'Nothing to do: items with the same markup share their problems, and fixing the first fixes the rest.',
    });
  return checks;
}

// ── run ──────────────────────────────────────────────────────────────────

/** Check the page for the experts asked; `progress` hears how far it has got (0 to 1). */
export async function review(experts: ExpertId[], axeSrc?: string, progress: (done: number) => void = () => undefined): Promise<PageReview> {
  const started = performance.now();
  const f = own(facts);
  const checks: PageCheck[] = [];
  const quick = ([['seo', seo], ['content', content], ['ux', ux]] as const).filter(([id]) => experts.includes(id));
  // The page's own checks are quick; accessibility is most of the work.
  const head = !experts.includes('a11y') ? 1 : quick.length ? 0.2 : 0;
  for (const [i, [, check]] of quick.entries()) {
    await pause();
    checks.push(...own(() => check(f)));
    progress((head * (i + 1)) / quick.length);
  }
  if (experts.includes('a11y')) {
    try {
      checks.push(...(await a11y(axeSrc, (done) => progress(head + (1 - head) * done))));
    } catch (err) {
      checks.push({ rule: 'axe:unavailable', expert: 'a11y', severity: 'info', title: 'Accessibility checks didn’t run', what: err instanceof Error ? err.message : String(err), fix: 'Reload the page and try again.' });
    }
  }
  return { facts: f, checks, ms: Math.round(performance.now() - started) };
}
