/**
 * Google data for reviewed pages, against a stand-in for Google's APIs: the
 * service account's key is kept privately, the access token comes from a
 * signed JWT (checked with the key's public half), and each service is asked
 * for the page the way its API expects. Failures are reported, not thrown.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleConnector } from '../../server/connectors/google';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY_JSON = JSON.stringify({ type: 'service_account', project_id: 'shop-123', private_key_id: 'abc', private_key: PEM, client_email: 'saywright@shop-123.iam.gserviceaccount.com', client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' });

type Call = { url: string; init: RequestInit; body: unknown };
let calls: Call[] = [];
let answer: (url: string, body: unknown) => { status: number; json: unknown };

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const raw = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, init, body: raw });
    const a = answer(url, raw);
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  });
});
afterEach(() => vi.unstubAllGlobals());

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-google-'));
const token = (url: string) => url === 'https://oauth2.googleapis.com/token';

describe('the service account', () => {
  it('keeps only what it needs, readable by this user alone', () => {
    const d = dir();
    const g = new GoogleConnector(d, () => undefined);
    expect(g.setAccount(KEY_JSON)).toEqual({ client_email: 'saywright@shop-123.iam.gserviceaccount.com', private_key: '', project_id: 'shop-123' });
    const file = path.join(d, 'google-service-account.json');
    // Windows has no such permission bits (a user's folders are theirs by its access rules).
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort()).toEqual(['client_email', 'private_key', 'project_id', 'type']);
    expect(g.account()?.client_email).toBe('saywright@shop-123.iam.gserviceaccount.com');
    g.setAccount(null);
    expect(fs.existsSync(file)).toBe(false);
    expect(g.account()).toBeNull();
  });

  it('refuses what isn’t a service account key', () => {
    const g = new GoogleConnector(dir(), () => undefined);
    expect(() => g.setAccount('not json')).toThrow(/paste the whole JSON/);
    expect(() => g.setAccount(JSON.stringify({ type: 'authorized_user', client_id: 'x' }))).toThrow(/isn’t a service account key/);
  });
});

describe('Search Console', () => {
  it('signs in with a JWT the key signed, then asks for the page’s totals and top queries', async () => {
    answer = (url, body) => {
      if (token(url)) return { status: 200, json: { access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' } };
      const b = body as { dimensions?: string[] };
      return b.dimensions
        ? { status: 200, json: { rows: [{ keys: ['linen napkins'], clicks: 30, impressions: 900, ctr: 0.033, position: 4.2 }] } }
        : { status: 200, json: { rows: [{ clicks: 41, impressions: 1500, ctr: 0.027, position: 6.1 }] } };
    };
    const g = new GoogleConnector(dir(), () => undefined);
    g.setAccount(KEY_JSON);
    const s = await g.search('sc-domain:tidewell.shop', 'https://tidewell.shop/checkout');
    expect(s).toEqual({ clicks: 41, impressions: 1500, ctr: 0.027, position: 6.1, queries: [{ query: 'linen napkins', clicks: 30, impressions: 900, position: 4.2 }] });

    const t = calls.filter((c) => token(c.url));
    expect(t).toHaveLength(1);
    const form = t[0].body as { grant_type: string; assertion: string };
    expect(form.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p, sig] = form.assertion.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'saywright@shop-123.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/webmasters.readonly', aud: 'https://oauth2.googleapis.com/token' });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);

    const q = calls.filter((c) => !token(c.url));
    expect(q).toHaveLength(2);
    expect(q[0].url).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Atidewell.shop/searchAnalytics/query');
    expect((q[0].init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.test');
    const body = q[1].body as { startDate: string; endDate: string; rowLimit: number; dimensionFilterGroups: unknown };
    expect(body.dimensionFilterGroups).toEqual([{ filters: [{ dimension: 'page', operator: 'equals', expression: 'https://tidewell.shop/checkout' }] }]);
    // 28 days, ending two days ago (Search Console's data lags).
    expect((Date.parse(body.endDate) - Date.parse(body.startDate)) / 86_400_000).toBe(27);
    expect(body.rowLimit).toBe(20);

    // The token is reused for the same scope.
    await g.search('sc-domain:tidewell.shop', 'https://tidewell.shop/');
    expect(calls.filter((c) => token(c.url))).toHaveLength(1);
  });
});

describe('Chrome UX Report', () => {
  it('asks for the page on phones, and the whole site when the page has too little traffic', async () => {
    answer = (_url, body) => {
      const b = body as { url?: string; origin?: string };
      if (b.url) return { status: 404, json: { error: { code: 404, message: 'chrome ux report data not found', status: 'NOT_FOUND' } } };
      return {
        status: 200,
        json: {
          record: {
            key: { origin: b.origin },
            metrics: { largest_contentful_paint: { percentiles: { p75: 2300 } }, interaction_to_next_paint: { percentiles: { p75: 140 } }, cumulative_layout_shift: { percentiles: { p75: '0.04' } } },
            collectionPeriod: { firstDate: { year: 2026, month: 9, day: 13 }, lastDate: { year: 2026, month: 10, day: 10 } },
          },
        },
      };
    };
    const g = new GoogleConnector(dir(), () => 'AIzaTestKey_0123456789abcdef');
    expect(await g.crux('https://tidewell.shop/checkout?utm=x')).toEqual({ lcp: 2300, inp: 140, cls: 0.04, scope: 'origin', period: '2026-09-13 to 2026-10-10' });
    expect(calls[0].url).toBe('https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=AIzaTestKey_0123456789abcdef');
    expect(calls[0].body).toMatchObject({ url: 'https://tidewell.shop/checkout?utm=x', formFactor: 'PHONE' });
    expect(calls[1].body).toMatchObject({ origin: 'https://tidewell.shop', formFactor: 'PHONE' });
  });

  it('has nothing to say without a key, or when Google has no data for the site', async () => {
    answer = () => ({ status: 404, json: { error: { message: 'not found' } } });
    expect(await new GoogleConnector(dir(), () => undefined).crux('https://a.example/')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await new GoogleConnector(dir(), () => 'AIzaTestKey_0123456789abcdef').crux('https://a.example/')).toBeNull();
  });
});

describe('Analytics', () => {
  it('reports the page’s views, users and engagement', async () => {
    answer = (url) =>
      token(url)
        ? { status: 200, json: { access_token: 'ya29.ga', expires_in: 3600 } }
        : { status: 200, json: { rows: [{ metricValues: [{ value: '1200' }, { value: '400' }, { value: '0.61' }, { value: '24000' }] }] } };
    const g = new GoogleConnector(dir(), () => undefined);
    g.setAccount(KEY_JSON);
    expect(await g.analytics('123456789', '/checkout')).toEqual({ views: 1200, users: 400, engagementRate: 0.61, avgEngagementSec: 60 });
    const report = calls.find((c) => c.url.includes('analyticsdata'))!;
    expect(report.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport');
    expect((report.body as { dimensionFilter: unknown }).dimensionFilter).toEqual({ filter: { fieldName: 'pagePath', stringFilter: { matchType: 'EXACT', value: '/checkout' } } });
    const claims = JSON.parse(Buffer.from(((calls[0].body as { assertion: string }).assertion.split('.')[1]), 'base64url').toString());
    expect(claims.scope).toBe('https://www.googleapis.com/auth/analytics.readonly');
  });
});

describe('everything for a page', () => {
  it('collects what works and reports what doesn’t', async () => {
    answer = (url) => {
      if (token(url)) return { status: 200, json: { access_token: 'ya29.x', expires_in: 3600 } };
      if (url.includes('chromeuxreport')) return { status: 200, json: { record: { metrics: { largest_contentful_paint: { percentiles: { p75: 1800 } } } } } };
      if (url.includes('webmasters')) return { status: 403, json: { error: { code: 403, message: 'User does not have sufficient permission for site', status: 'PERMISSION_DENIED' } } };
      return { status: 200, json: {} };
    };
    const g = new GoogleConnector(dir(), () => 'AIzaTestKey_0123456789abcdef');
    g.setAccount(KEY_JSON);
    const f = await g.field('https://tidewell.shop/', { searchConsoleSite: 'https://tidewell.shop/', ga4Property: '42424242' });
    expect(f.crux).toMatchObject({ lcp: 1800, inp: null, cls: null, scope: 'url' });
    expect(f.search).toBeUndefined();
    expect(f.analytics).toEqual({ views: 0, users: 0, engagementRate: 0, avgEngagementSec: 0 });
    expect(f.errors).toEqual(['Search Console: User does not have sufficient permission for site']);
  });

  it('asks nothing it isn’t set up for', async () => {
    answer = () => ({ status: 500, json: {} });
    const f = await new GoogleConnector(dir(), () => undefined).field('https://tidewell.shop/', { searchConsoleSite: 'x', ga4Property: '1' });
    expect(f).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
