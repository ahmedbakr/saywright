/**
 * What a search engine's crawler sees that the page itself can't tell: the
 * HTTP status and redirects, X-Robots-Tag, how big the HTML is, robots.txt
 * and the sitemap. Rules from Google Search Central (crawling and indexing).
 */
import type { PageCheck } from '@saywright/vite/protocol';

const G = 'https://developers.google.com/search/docs';
const UA = 'Mozilla/5.0 (compatible; Saywright-SEO-check/1.0; +https://github.com/ahmedbakr/saywright)';

interface CrawlFacts {
  url: string;
  status: number | null;
  finalUrl: string;
  redirects: { url: string; status: number }[];
  xRobots: string | null;
  bytes: number | null;
  contentType: string | null;
  robots: { status: number; bytes: number; sitemaps: string[]; blocks: boolean; rule: string | null } | null;
  sitemap: { url: string; status: number; urls: number; listsPage: boolean | null } | null;
  /** On this computer: robots and sitemap only count on a public address. */
  local: boolean;
  error?: string;
}

async function get(url: string, timeoutMs = 10_000): Promise<Response> {
  return fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
}

/** Google's robots.txt matching: the longest matching rule wins; Allow wins a tie; * and $ wildcards. */
export function robotsBlocks(robotsTxt: string, path: string, agent = 'googlebot'): { blocked: boolean; rule: string | null } {
  type Rule = { allow: boolean; pattern: string };
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') current.rules.push({ allow: key === 'allow', pattern: value });
  }
  // A group is for a crawler when its name (up to any "/version") is the crawler's own, ignoring case.
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && /^[a-z_-]+/.exec(a)?.[0] === agent));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  // "Disallow:" with nothing after it allows everything: it matches nothing.
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== '');
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let best: Rule | null = null;
  for (const r of rules) {
    const anchored = r.pattern.endsWith('$');
    const body = anchored ? r.pattern.slice(0, -1) : r.pattern;
    const re = new RegExp(`^${body.split('*').map(escape).join('.*')}${anchored ? '$' : ''}`);
    if (!re.test(path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return { blocked: !!best && !best.allow, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` : null };
}

const isLocal = (u: URL) => /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(u.hostname) || u.hostname.endsWith('.localhost') || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(u.hostname);

export async function crawl(pageUrl: string, opts: { assumePublic?: boolean } = {}): Promise<{ facts: CrawlFacts; checks: PageCheck[] }> {
  const checks: PageCheck[] = [];
  const add = (c: Omit<PageCheck, 'expert'>) => checks.push({ ...c, expert: 'seo' });
  const start = new URL(pageUrl);
  start.hash = '';
  const facts: CrawlFacts = { url: start.href, status: null, finalUrl: start.href, redirects: [], xRobots: null, bytes: null, contentType: null, robots: null, sitemap: null, local: !opts.assumePublic && isLocal(start) };

  // The page, following redirects by hand to see each hop.
  let url = start.href;
  try {
    for (let hop = 0; hop < 11; hop++) {
      const res = await get(url);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        facts.redirects.push({ url, status: res.status });
        url = new URL(res.headers.get('location')!, url).href;
        await res.body?.cancel();
        continue;
      }
      facts.status = res.status;
      facts.finalUrl = url;
      facts.xRobots = res.headers.get('x-robots-tag');
      facts.contentType = res.headers.get('content-type');
      const body = Buffer.from(await res.arrayBuffer());
      facts.bytes = body.length;
      break;
    }
  } catch (err) {
    facts.error = err instanceof Error ? err.message : String(err);
    add({ rule: 'SEO-01', severity: 'high', title: 'The page didn’t answer', what: `Fetching ${start.href} failed: ${facts.error}.`, fix: 'Check that the address is reachable from this computer.', source: `${G}/crawling-indexing/http-status-codes` });
    return { facts, checks };
  }

  if (facts.status !== null && facts.status !== 200) {
    const gone = facts.status >= 400 && facts.status < 500 && facts.status !== 429;
    add({ rule: 'SEO-01', severity: gone ? 'blocker' : 'high', title: `The page returns ${facts.status}`, what: gone ? `A ${facts.status} tells Google the page doesn’t exist; it is dropped from the index.` : `A ${facts.status} makes Google slow down crawling.`, fix: 'Pages meant to rank must return 200; return 404 or 410 only for pages that are gone.', source: `${G}/crawling-indexing/http-status-codes` });
  }
  if (facts.redirects.length) {
    const temp = facts.redirects.filter((r) => r.status === 302 || r.status === 307);
    add({
      rule: 'SEO-02',
      severity: facts.redirects.length >= 10 ? 'blocker' : facts.redirects.length > 3 ? 'high' : facts.redirects.length > 1 ? 'medium' : 'info',
      title: facts.redirects.length > 1 ? `A chain of ${facts.redirects.length} redirects` : 'The address redirects',
      what: `${[...facts.redirects.map((r) => `${r.url} (${r.status})`), facts.finalUrl].join(' → ')}.${temp.length ? ' Temporary redirects (302/307) keep the old address as the canonical one.' : ''}`,
      fix: 'Link straight to the final address, keep chains to one hop, and use 301/308 for permanent moves.',
      source: `${G}/crawling-indexing/301-redirects`,
    });
  }
  if (facts.xRobots && /\b(noindex|none)\b/i.test(facts.xRobots)) add({ rule: 'SEO-05', severity: 'blocker', title: 'The server says not to index this page', what: `X-Robots-Tag: ${facts.xRobots}`, fix: 'Remove noindex from the response headers of pages meant to rank.', source: `${G}/crawling-indexing/robots-meta-tag` });
  if (facts.bytes && facts.bytes > 2 * 1024 * 1024 && /html/i.test(facts.contentType ?? '')) add({ rule: 'SEO-04', severity: 'high', title: 'The HTML is over 2 MB', what: `The page’s HTML is ${(facts.bytes / 1024 / 1024).toFixed(1)} MB; Googlebot reads only the first 2 MB.`, fix: 'Move inline data and SVG out of the HTML, and load long lists on demand.', source: `${G}/crawling-indexing/googlebot` });

  // robots.txt and the sitemap mean something only on a public address.
  if (facts.local) return { facts, checks };
  const origin = new URL(facts.finalUrl).origin;
  try {
    const res = await get(`${origin}/robots.txt`);
    const text = res.status === 200 && !/html/i.test(res.headers.get('content-type') ?? '') ? await res.text() : '';
    if (res.status !== 200) await res.body?.cancel();
    const bytes = Buffer.byteLength(text);
    const sitemaps = [...text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]);
    const path = new URL(facts.finalUrl).pathname + new URL(facts.finalUrl).search;
    const b = text ? robotsBlocks(text, path) : { blocked: false, rule: null };
    facts.robots = { status: res.status, bytes, sitemaps, blocks: b.blocked, rule: b.rule };
    if (res.status >= 500) add({ rule: 'SEO-08', severity: 'blocker', title: `robots.txt returns ${res.status}`, what: 'When robots.txt fails with a server error, Google stops crawling the whole site for a while.', fix: 'Serve robots.txt with 200 (or 404 if you have none).', source: 'https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec' });
    if (bytes > 500 * 1024) add({ rule: 'SEO-08', severity: 'medium', title: 'robots.txt is over 500 KiB', what: 'Google ignores everything after the first 500 KiB.', fix: 'Shorten it: group rules with wildcards.', source: 'https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec' });
    const relative = sitemaps.filter((s) => !/^https?:\/\//i.test(s));
    if (relative.length) add({ rule: 'SEO-08', severity: 'low', title: 'Sitemap lines with relative URLs', what: `robots.txt lists ${relative.join(', ')}.`, fix: 'Give Sitemap: lines absolute URLs.', source: 'https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec' });
    if (b.blocked) add({ rule: 'SEO-09', severity: 'blocker', title: 'robots.txt blocks this page', what: `“${b.rule}” matches ${path}, so Google won’t crawl it (it may still list the bare URL).`, fix: 'Allow the page in robots.txt; to keep it out of results, use noindex instead (and let it be crawled).', source: `${G}/crawling-indexing/robots/intro` });
  } catch {
    /* no robots.txt to judge */
  }
  try {
    const where = facts.robots?.sitemaps.find((s) => /^https?:\/\//i.test(s)) ?? `${origin}/sitemap.xml`;
    const res = await get(where);
    if (res.status === 200) {
      const xml = await res.text();
      const urls = (xml.match(/<loc>/gi) ?? []).length;
      const index = /<sitemapindex/i.test(xml);
      const listsPage = index ? null : xml.includes(`<loc>${facts.finalUrl}</loc>`) || xml.includes(`<loc>${facts.finalUrl.replace(/\/$/, '')}</loc>`);
      facts.sitemap = { url: where, status: 200, urls, listsPage };
      if (!/<(urlset|sitemapindex)\b/i.test(xml)) add({ rule: 'SEO-10', severity: 'medium', title: 'The sitemap isn’t a sitemap', what: `${where} returns no <urlset> or <sitemapindex>.`, fix: 'Serve an XML sitemap.', source: `${G}/crawling-indexing/sitemaps/build-sitemap` });
      else if (urls > 50_000) add({ rule: 'SEO-10', severity: 'medium', title: 'The sitemap is too long', what: `${urls} entries; one file holds at most 50,000.`, fix: 'Split it and list the parts in a sitemap index.', source: `${G}/crawling-indexing/sitemaps/large-sitemaps` });
      else if (listsPage === false) add({ rule: 'SEO-11', severity: 'low', title: 'The sitemap doesn’t list this page', what: `${where} has ${urls} URLs, not this one.`, fix: 'List every page meant to rank, by its canonical URL.', source: `${G}/crawling-indexing/sitemaps/build-sitemap` });
    } else {
      await res.body?.cancel();
      facts.sitemap = { url: where, status: res.status, urls: 0, listsPage: null };
      add({ rule: 'SEO-10', severity: 'low', title: 'No sitemap found', what: `${where} returns ${res.status}${facts.robots?.sitemaps.length ? '' : ', and robots.txt names none'}.`, fix: 'Publish an XML sitemap and name it in robots.txt.', source: `${G}/crawling-indexing/sitemaps/build-sitemap` });
    }
  } catch {
    /* no sitemap to judge */
  }
  return { facts, checks };
}
