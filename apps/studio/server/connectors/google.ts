/**
 * Real-user data from Google, for a page's public address:
 * - Chrome UX Report (an API key): Core Web Vitals of real Chrome users, 75th
 *   percentile over 28 days.
 * - Search Console and Google Analytics 4 (a service account the person adds
 *   to their property): the queries that bring people to the page, and how
 *   they engage with it.
 * The service account's key stays in the studio's data folder, readable by
 * this user only; access tokens live in memory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FieldData } from '../../shared/experts.ts';
import { writeFileAtomic } from '../fsx.ts';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface GoogleSettings {
  /** Search Console property: "https://example.com/" or "sc-domain:example.com". */
  searchConsoleSite?: string;
  /** GA4 property id (numbers). */
  ga4Property?: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string; status?: string } } | null)?.error?.message ?? text.slice(0, 200);
    const err = new Error(msg || `HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return body;
}

export class GoogleConnector {
  private token: { value: string; until: number; scope: string } | null = null;

  constructor(
    private dataDir: string,
    private apiKey: () => string | undefined,
  ) {}

  private get keyFile() {
    return path.join(this.dataDir, 'google-service-account.json');
  }

  account(): ServiceAccount | null {
    try {
      const a = JSON.parse(fs.readFileSync(this.keyFile, 'utf8')) as ServiceAccount;
      return a.client_email && a.private_key ? a : null;
    } catch {
      return null;
    }
  }

  /** Save a service account key (the JSON from Google Cloud), or remove it (null). */
  setAccount(json: string | null): ServiceAccount | null {
    if (json === null) {
      fs.rmSync(this.keyFile, { force: true });
      this.token = null;
      return null;
    }
    let a: ServiceAccount & { type?: string };
    try {
      a = JSON.parse(json);
    } catch {
      throw new Error('That isn’t a service account key: paste the whole JSON file.');
    }
    if (a.type !== 'service_account' || !a.client_email || !/BEGIN PRIVATE KEY/.test(a.private_key ?? '')) throw new Error('That JSON isn’t a service account key (it needs client_email and private_key).');
    writeFileAtomic(this.keyFile, JSON.stringify({ type: 'service_account', client_email: a.client_email, private_key: a.private_key, project_id: a.project_id }), { mode: 0o600 });
    this.token = null;
    return { client_email: a.client_email, private_key: '', project_id: a.project_id };
  }

  /** An access token for the service account (a signed JWT exchanged at Google's token endpoint). */
  private async accessToken(scope: string): Promise<string> {
    if (this.token && this.token.scope === scope && this.token.until > Date.now() + 60_000) return this.token.value;
    const a = this.account();
    if (!a) throw new Error('No Google service account yet.');
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: a.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(a.private_key).toString('base64url');
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` });
    const res = (await call('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })) as { access_token: string; expires_in: number };
    this.token = { value: res.access_token, until: Date.now() + res.expires_in * 1000, scope };
    return res.access_token;
  }

  /** Chrome UX Report for the page, or the whole origin when the page has too little traffic. */
  async crux(url: string): Promise<FieldData['crux']> {
    const key = this.apiKey();
    if (!key) return null;
    const metrics = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'];
    const query = async (body: Record<string, unknown>) => (await call(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, formFactor: 'PHONE', metrics }) })) as {
      record: { metrics: Record<string, { percentiles?: { p75?: number | string } }>; collectionPeriod?: { firstDate: { year: number; month: number; day: number }; lastDate: { year: number; month: number; day: number } } };
    };
    let scope: 'url' | 'origin' = 'url';
    let res;
    try {
      res = await query({ url });
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      scope = 'origin';
      try {
        res = await query({ origin: new URL(url).origin });
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }
    }
    const p75 = (k: string) => {
      const v = res.record.metrics[k]?.percentiles?.p75;
      return v == null ? null : Number(v);
    };
    const d = (x?: { year: number; month: number; day: number }) => (x ? `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}` : '');
    return { lcp: p75('largest_contentful_paint'), inp: p75('interaction_to_next_paint'), cls: p75('cumulative_layout_shift'), scope, period: `${d(res.record.collectionPeriod?.firstDate)} to ${d(res.record.collectionPeriod?.lastDate)}` };
  }

  /** Search Console: the page's clicks, impressions and top queries over the last 28 days. */
  async search(site: string, url: string): Promise<FieldData['search']> {
    const token = await this.accessToken('https://www.googleapis.com/auth/webmasters.readonly');
    const end = new Date(Date.now() - 2 * 86_400_000);
    const start = new Date(end.getTime() - 27 * 86_400_000);
    const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
    const filter = { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: url }] }] };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    type Rows = { rows?: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[] };
    const [total, byQuery] = (await Promise.all([
      call(endpoint, { method: 'POST', headers, body: JSON.stringify({ startDate: day(start), endDate: day(end), ...filter }) }),
      call(endpoint, { method: 'POST', headers, body: JSON.stringify({ startDate: day(start), endDate: day(end), dimensions: ['query'], rowLimit: 20, ...filter }) }),
    ])) as [Rows, Rows];
    const t = total.rows?.[0];
    return {
      clicks: t?.clicks ?? 0,
      impressions: t?.impressions ?? 0,
      ctr: t?.ctr ?? 0,
      position: t?.position ?? 0,
      queries: (byQuery.rows ?? []).map((r) => ({ query: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, position: r.position })),
    };
  }

  /** Google Analytics 4: the page's views, users and engagement over the last 28 days. */
  async analytics(property: string, pagePath: string): Promise<FieldData['analytics']> {
    const token = await this.accessToken('https://www.googleapis.com/auth/analytics.readonly');
    const res = (await call(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'engagementRate' }, { name: 'userEngagementDuration' }],
        dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'EXACT', value: pagePath } } },
      }),
    })) as { rows?: { metricValues: { value: string }[] }[] };
    const v = res.rows?.[0]?.metricValues.map((m) => Number(m.value)) ?? [0, 0, 0, 0];
    return { views: v[0], users: v[1], engagementRate: v[2], avgEngagementSec: v[1] ? v[3] / v[1] : 0 };
  }

  /** Everything configured, for one public page address. Failures are reported, not thrown. */
  async field(url: string, settings: GoogleSettings): Promise<FieldData> {
    const out: FieldData = { errors: [] };
    const tasks: Promise<void>[] = [];
    if (this.apiKey()) tasks.push(this.crux(url).then((c) => void (out.crux = c), (e) => void out.errors!.push(`Chrome UX Report: ${e instanceof Error ? e.message : e}`)));
    if (this.account() && settings.searchConsoleSite) tasks.push(this.search(settings.searchConsoleSite, url).then((s) => void (out.search = s), (e) => void out.errors!.push(`Search Console: ${e instanceof Error ? e.message : e}`)));
    if (this.account() && settings.ga4Property) tasks.push(this.analytics(settings.ga4Property, new URL(url).pathname).then((a) => void (out.analytics = a), (e) => void out.errors!.push(`Analytics: ${e instanceof Error ? e.message : e}`)));
    await Promise.all(tasks);
    if (!out.errors!.length) delete out.errors;
    return out;
  }
}
