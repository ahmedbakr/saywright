import { ExternalLink, Eye, EyeOff, FileJson, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { Badge, Dot, Spinner } from '@/components/ui/misc';
import { apps, useApps } from '@/core/apps';
import { set as setStudio } from '@/core/store';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Section, Title, input } from './AiSettings';

interface GoogleState {
  /** "AIza…x1y2" when a key is saved. */
  apiKey: string | null;
  account: { email: string; project: string | null } | null;
  /** This app's Search Console property and GA4 property. */
  settings: { searchConsoleSite?: string; ga4Property?: string };
  /** Where Google's data for this app comes from (its production address), if it has one. */
  publicUrl: string | null;
}

type Result = { ok: boolean; message: string } | null;

const LINKS = {
  key: 'https://console.cloud.google.com/apis/credentials',
  crux: 'https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com',
  serviceAccounts: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
  searchApi: 'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com',
  analyticsApi: 'https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com',
};

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="inline-flex items-center gap-0.5 text-human-fg hover:underline" href={href} target="_blank" rel="noreferrer">
      {children} <ExternalLink className="size-3" />
    </a>
  );
}

function Message({ r }: { r: Result }) {
  if (!r) return null;
  return <p className={cn('mt-1.5 text-[12px] leading-relaxed', r.ok ? 'text-ok' : 'text-bad')}>{r.message}</p>;
}

/** Google's real-user data for the pages the experts review. */
export function ServicesSettings() {
  const [state, setState] = useState<GoogleState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const appName = useApps((s) => s.apps.find((a) => a.id === s.active)?.name ?? null);
  useEffect(() => {
    api.get<GoogleState>('/connectors/google').then(setState, (e: Error) => setLoadError(e.message));
  }, []);

  const save = async (body: Record<string, unknown>): Promise<Result> => {
    try {
      setState(await api.put<GoogleState>('/connectors/google', body));
      return { ok: true, message: 'Saved.' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  };

  if (!state) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
        {loadError ?? (
          <>
            <Spinner /> Loading…
          </>
        )}
      </div>
    );
  }
  return (
    <>
      <Title sub="Real-user data next to the expert reviews: how fast your pages are for real visitors, what people search to find them, and how they use them. Read-only, from your own Google accounts, for your production address.">Google data</Title>
      <KeySection state={state} save={save} />
      <AccountSection state={state} save={save} />
      <AppSection key={appName ?? ''} state={state} save={save} appName={appName} />
    </>
  );
}

function KeySection({ state, save }: { state: GoogleState; save: (b: Record<string, unknown>) => Promise<Result> }) {
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  return (
    <Section title="Speed for real users" sub="Chrome UX Report: Core Web Vitals of real Chrome users on phones over the last 28 days. Free; needs a Google Cloud API key with the Chrome UX Report API turned on.">
      <div className="px-3 py-3" data-service="crux">
        <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
          Google API key{' '}
          {state.apiKey ? (
            <Badge tone="ok">
              <Dot tone="ok" className="mr-0.5" /> {state.apiKey}
            </Badge>
          ) : (
            <Badge>No key</Badge>
          )}
        </div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">
          <Ext href={LINKS.key}>Create a key</Ext> · <Ext href={LINKS.crux}>Turn on the Chrome UX Report API</Ext>
        </div>
        <form
          className="mt-2 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!key.trim()) return;
            setBusy(true);
            const r = await save({ apiKey: key.trim() });
            setBusy(false);
            setResult(r);
            if (r?.ok) setKey('');
          }}
        >
          <div className="relative min-w-0 flex-1">
            <input
              data-hand
              type={show ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={state.apiKey ? 'Replace the key' : 'Paste a Google API key'}
              autoComplete="off"
              spellCheck={false}
              aria-label="Google API key"
              className={cn(input, 'w-full pr-8 font-mono')}
            />
            <button type="button" className="absolute right-1.5 top-1.5 text-fg-3 hover:text-fg [&_svg]:size-[14px]" onClick={() => setShow(!show)} aria-label={show ? 'Hide key' : 'Show key'}>
              {show ? <EyeOff /> : <Eye />}
            </button>
          </div>
          <Button type="submit" size="md" variant="primary" disabled={!key.trim() || busy}>
            {busy ? <Spinner /> : 'Save'}
          </Button>
          {state.apiKey && (
            <Button type="button" size="md" variant="ghost" aria-label="Remove the Google API key" onClick={async () => (await confirmAction({ title: 'Remove the Google API key?', body: 'It is deleted from this computer. Real-user speed data (Chrome UX Report) stops until you add a key again.', action: 'Remove', danger: true })) && setResult(await save({ apiKey: null }))}>
              <Trash2 />
            </Button>
          )}
        </form>
        <Message r={result} />
        <p className="mt-1.5 text-[11.5px] text-fg-3">Saved in .env.local in the Saywright folder, readable only by you. Restrict it to the Chrome UX Report API in Google Cloud.</p>
      </div>
    </Section>
  );
}

function AccountSection({ state, save }: { state: GoogleState; save: (b: Record<string, unknown>) => Promise<Result> }) {
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const file = useRef<HTMLInputElement>(null);
  const submit = async (text: string) => {
    setBusy(true);
    const r = await save({ account: text });
    setBusy(false);
    setResult(r);
    if (r?.ok) setJson('');
  };
  return (
    <Section
      title="Search Console and Analytics"
      sub="A Google Cloud service account that you add, read-only, to your Search Console property and your Google Analytics 4 property. Saywright signs in as it; your own Google password is never asked for."
    >
      <div className="px-3 py-3" data-service="account">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
              Service account{' '}
              {state.account ? (
                <Badge tone="ok">
                  <Dot tone="ok" className="mr-0.5" /> Added
                </Badge>
              ) : (
                <Badge>Not added</Badge>
              )}
            </div>
            {state.account && <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-2">{state.account.email}</div>}
          </div>
          {state.account && (
            <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={async () => (await confirmAction({ title: 'Remove the service account key?', body: 'It is deleted from this computer. Search Console and Analytics data stop until you add it again.', action: 'Remove', danger: true })) && setResult(await save({ account: null }))}>
              Remove
            </Button>
          )}
        </div>
        {!state.account && (
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-[12px] leading-relaxed text-fg-3">
            <li>
              <Ext href={LINKS.serviceAccounts}>Create a service account</Ext> and add a JSON key to it.
            </li>
            <li>
              Turn on the <Ext href={LINKS.searchApi}>Search Console API</Ext> and the <Ext href={LINKS.analyticsApi}>Google Analytics Data API</Ext>.
            </li>
            <li>Add its email address as a user: in Search Console (Settings → Users, Restricted) and in Analytics (Admin → Property access, Viewer).</li>
            <li>Choose the key file, or paste what it says, below.</li>
          </ol>
        )}
        <div className="mt-2 space-y-2">
          <textarea
            data-hand
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder={state.account ? 'Paste another key to replace it' : '{ "type": "service_account", "client_email": "…", "private_key": "…" }'}
            spellCheck={false}
            autoComplete="off"
            rows={3}
            aria-label="Service account key (JSON)"
            className={cn(input, 'block h-auto w-full resize-none py-2 font-mono text-[11.5px]')}
          />
          <div className="flex items-center gap-2">
            <Button size="md" variant="primary" disabled={!json.trim() || busy} onClick={() => void submit(json)}>
              {busy ? <Spinner /> : 'Save'}
            </Button>
            <Button size="md" icon={<FileJson />} onClick={() => file.current?.click()} disabled={busy}>
              Choose the key file
            </Button>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > 20_000) return setResult({ ok: false, message: 'That file is too big to be a service account key.' });
                await submit(await f.text());
              }}
            />
          </div>
        </div>
        <Message r={result} />
        <p className="mt-1.5 text-[11.5px] text-fg-3">Kept in Saywright’s data folder, readable only by you. Only its email and private key are kept; it is sent nowhere but Google.</p>
      </div>
    </Section>
  );
}

function AppSection({ state, save, appName }: { state: GoogleState; save: (b: Record<string, unknown>) => Promise<Result>; appName: string | null }) {
  const [site, setSite] = useState(state.settings.searchConsoleSite ?? '');
  const [property, setProperty] = useState(state.settings.ga4Property ?? '');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<Result>(null);
  const dirty = site.trim() !== (state.settings.searchConsoleSite ?? '') || property.trim() !== (state.settings.ga4Property ?? '');
  const badProperty = property.trim() !== '' && !/^\d{4,15}$/.test(property.trim());
  const nothing = !state.apiKey && !state.account;

  if (!appName) {
    return (
      <Section title="This app">
        <p className="px-3 py-3 text-[12px] text-fg-3">Open an app to choose its Search Console and Analytics properties.</p>
      </Section>
    );
  }
  return (
    <Section title={`For ${appName}`} sub="Each linked app has its own properties. Data is looked up for the same page on the app’s production address.">
      <div className="space-y-3 px-3 py-3" data-service="app">
        <div className="text-[12px] leading-relaxed">
          <span className="text-fg-3">Production address: </span>
          {state.publicUrl ? (
            <span className="font-mono text-[11.5px] text-fg-2">{state.publicUrl}</span>
          ) : (
            <span className="text-warn">
              none yet.{' '}
              <button
                className="text-human-fg hover:underline"
                onClick={() => {
                  setStudio({ overlay: null });
                  apps.show();
                }}
              >
                Add one to the app
              </button>{' '}
              (Google only has data for public pages).
            </span>
          )}
        </div>
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-fg">Search Console property</span>
          <input data-hand value={site} onChange={(e) => setSite(e.target.value)} placeholder="sc-domain:example.com  or  https://www.example.com/" spellCheck={false} className={cn(input, 'w-full font-mono')} />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-fg">Google Analytics 4 property ID</span>
          <input data-hand value={property} onChange={(e) => setProperty(e.target.value)} placeholder="123456789 (Admin → Property details)" inputMode="numeric" spellCheck={false} className={cn(input, 'w-full font-mono')} aria-invalid={badProperty} />
          {badProperty && <span className="block text-[11.5px] text-bad">A property ID is only numbers (not the G-… measurement ID).</span>}
        </label>
        <div className="flex items-center gap-2">
          <Button
            size="md"
            variant="primary"
            disabled={!dirty || badProperty || !!busy}
            onClick={async () => {
              setBusy('save');
              setResult(await save({ settings: { searchConsoleSite: site.trim(), ga4Property: property.trim() } }));
              setBusy(null);
            }}
          >
            {busy === 'save' ? <Spinner /> : 'Save'}
          </Button>
          <Button
            size="md"
            disabled={!!busy || dirty || nothing}
            title={nothing ? 'Add an API key or a service account first' : dirty ? 'Save first' : undefined}
            onClick={async () => {
              setBusy('test');
              try {
                setResult(await api.post<{ ok: boolean; message: string }>('/connectors/google/test'));
              } catch (e) {
                setResult({ ok: false, message: (e as Error).message });
              }
              setBusy(null);
            }}
            data-test-google
          >
            {busy === 'test' ? <Spinner /> : 'Test'}
          </Button>
        </div>
        <Message r={result} />
      </div>
    </Section>
  );
}
