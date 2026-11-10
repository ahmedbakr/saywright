import { Check, Copy, ExternalLink, Eye, EyeOff, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { Badge, Dot, Spinner } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ai, useAi } from '@/core/ai';
import { cn } from '@/lib/cn';
import { compact, usd } from '@/lib/format';
import { PrivacyNote } from '../Privacy';
import { AI_TASKS, type AiEffort, type AiState, type ConnectionView, type ModelInfo, type UsageRow, type UsageTotals } from '@shared/ai';
import { PRESETS, PRICES_AS_OF } from '@shared/models';

export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{children}</h2>
      {sub && <p className="mt-1 max-w-[500px] text-[12.5px] leading-relaxed text-fg-3">{sub}</p>}
    </div>
  );
}

export function Section({ title, sub, children, id }: { title: string; sub?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-6 scroll-mt-4 first:mt-0">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.04em] text-fg-3">{title}</h3>
      {sub && <p className="mt-1 max-w-[500px] text-[12px] leading-relaxed text-fg-3">{sub}</p>}
      <div className="mt-2 divide-y divide-line rounded-[10px] ring-1 ring-inset ring-line">{children}</div>
    </section>
  );
}

export const input = 'h-8 min-w-0 rounded-[8px] bg-sunken px-2.5 text-[12.5px] text-fg ring-1 ring-inset ring-line-strong outline-none placeholder:text-fg-3 focus:ring-human-line';

function useAiState(): AiState | null {
  const state = useAi((s) => s.state);
  useEffect(() => {
    void ai.load(true);
  }, []);
  return state;
}

function StatusBadge({ c }: { c: ConnectionView }) {
  if (c.disabled) return <Badge>Off</Badge>;
  switch (c.status) {
    case 'ready':
      return (
        <Badge tone="ok">
          <Dot tone="ok" className="mr-0.5" /> Ready
        </Badge>
      );
    case 'needs-key':
      return <Badge>No key</Badge>;
    case 'needs-login':
      return <Badge tone="warn">Sign in needed</Badge>;
    case 'missing':
      return <Badge>Not installed</Badge>;
    case 'offline':
      return <Badge>Not running</Badge>;
    default:
      return <Badge tone="warn">Problem</Badge>;
  }
}

function priceNote(c: ConnectionView, m: ModelInfo): string {
  if (c.auth === 'subscription') return 'Included in your plan';
  if (c.auth === 'local' && c.preset !== 'custom') return 'Free, on this computer';
  // Never "$0" for a model nobody has priced: under a budget it is counted at its provider's dearest known rates.
  if (!m.price) return [m.note, c.auth === 'key' ? 'price unknown' : ''].filter(Boolean).join(' · ');
  return `$${m.price.input} in · $${m.price.output} out per 1M tokens`;
}

const SHORT: Record<string, string> = {
  'claude-code': 'Claude plan',
  codex: 'ChatGPT plan',
  'gemini-cli': 'Gemini (Google account)',
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
  gemini: 'Gemini API',
};

/** Who does each job, and how hard it thinks. */
function Routes({ state }: { state: AiState }) {
  const usable = state.connections.filter((c) => c.status === 'ready' && !c.disabled && c.models.length);
  return (
    <Section title="Who does what" sub="Automatic picks your plan first (no extra cost), then an API key, then a model on this computer. Choose a model per job to balance quality and cost.">
      {AI_TASKS.map((t) => {
        const route = state.routes[t.id];
        const chosen = state.chosen[t.id];
        const auto = route ? `${SHORT[route.connection] ?? state.connections.find((c) => c.id === route.connection)?.label ?? route.connection} · ${state.connections.find((c) => c.id === route.connection)?.models.find((m) => m.id === route.model)?.label ?? route.model}` : 'Nothing connected yet';
        const options = [
          { value: 'auto', label: 'Automatic', note: auto },
          ...usable.flatMap((c) => c.models.map((m) => ({ value: `${c.id}::${m.id}`, label: `${SHORT[c.id] ?? c.label} · ${m.label}`, note: priceNote(c, m) }))),
        ];
        return (
          <div key={t.id} className="flex items-center justify-between gap-4 px-3 py-3" data-route={t.id}>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-fg">{t.label}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">{t.hint}</div>
              {!chosen && <div className="mt-1 text-[11.5px] text-fg-3" data-route-now>Now: {auto}</div>}
            </div>
            <Select<string>
              value={chosen && route?.connection === chosen.connection && route.model === chosen.model ? `${chosen.connection}::${chosen.model}` : 'auto'}
              onChange={(v) => {
                if (v === 'auto') return void ai.setRoute(t.id, null);
                const [connection, ...rest] = v.split('::');
                void ai.setRoute(t.id, { connection, model: rest.join('::') });
              }}
              options={options}
              className="w-[250px] shrink-0"
            />
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-4 px-3 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg">Effort</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">Higher effort thinks longer on hard requests, and uses more tokens.</div>
        </div>
        <Segmented<AiEffort>
          value={state.effort}
          onChange={(v) => void ai.setEffort(v)}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
        />
      </div>
    </Section>
  );
}

const INSTALL: Record<string, { install: string; signIn: string; site: string }> = {
  'claude-code': { install: 'npm install -g @anthropic-ai/claude-code', signIn: 'claude', site: 'https://claude.com/claude-code' },
  codex: { install: 'npm install -g @openai/codex', signIn: 'codex login', site: 'https://developers.openai.com/codex' },
  'gemini-cli': { install: 'npm install -g @google/gemini-cli', signIn: 'gemini', site: 'https://github.com/google-gemini/gemini-cli' },
};

const KEY_URL: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
};

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label ?? 'Copy'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

function CopyText({ text, label, shown }: { text: string; label?: string; shown?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-[6px] bg-sunken px-2 py-1 font-mono text-[11.5px] text-fg-2">{shown ?? text}</code>
      <CopyButton text={text} label={label} />
    </div>
  );
}

function PlanRow({ c }: { c: ConnectionView }) {
  const how = INSTALL[c.id];
  const loading = useAi((s) => s.loading);
  return (
    <div className="px-3 py-3" data-connection={c.id}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
            {c.label} <StatusBadge c={c} />
          </div>
          {c.detail && <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">{c.detail}</div>}
        </div>
        {c.status === 'ready' ? (
          <Switch checked={!c.disabled} onCheckedChange={(v) => void ai.setOff(c.id, !v)} aria-label={`Use ${c.label}`} />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void ai.load(true)} disabled={loading} icon={loading ? <Spinner /> : <RefreshCw />}>
            Check again
          </Button>
        )}
      </div>
      {how && (c.status === 'missing' || c.status === 'needs-login') && (
        <div className="mt-2 space-y-1.5 text-[12px] text-fg-3">
          {c.status === 'missing' && (
            <>
              <div>1. Install it:</div>
              <CopyText text={how.install} />
            </>
          )}
          <div>{c.status === 'missing' ? '2. ' : ''}Sign in with your account (once, in a terminal):</div>
          <CopyText text={how.signIn} />
          <a className="inline-flex items-center gap-1 text-human-fg hover:underline" href={how.site} target="_blank" rel="noreferrer">
            About it <ExternalLink className="size-3" />
          </a>
        </div>
      )}
    </div>
  );
}

function KeyRow({ c, file }: { c: ConnectionView; file?: string }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [show, setShow] = useState(false);
  const busy = useAi((s) => !!s.busy[c.id]);
  const result = useAi((s) => s.results[c.id]);
  const hasKey = c.status === 'ready' || !!c.detail?.startsWith('Key');
  return (
    <div className="px-3 py-3" data-connection={c.id}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
            {c.label} <StatusBadge c={c} />
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">
            {c.detail ?? 'Billed per use by the provider.'}{' '}
            {KEY_URL[c.id] && (
              <a className="inline-flex items-center gap-0.5 text-human-fg hover:underline" href={KEY_URL[c.id]} target="_blank" rel="noreferrer">
                Get a key <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>
        {c.status === 'ready' && <Switch checked={!c.disabled} onCheckedChange={(v) => void ai.setOff(c.id, !v)} aria-label={`Use ${c.label}`} />}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim()) return;
          void ai.saveKey(c.id, key.trim()).then((ok) => ok && setKey(''));
        }}
      >
        <div className="relative min-w-0 flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? 'Replace the key' : 'Paste an API key'}
            autoComplete="off"
            spellCheck={false}
            aria-label={`${c.label} key`}
            className={cn(input, 'w-full pr-8 font-mono')}
          />
          <button type="button" className="absolute right-1.5 top-1.5 text-fg-3 hover:text-fg [&_svg]:size-[14px]" onClick={() => setShow(!show)} aria-label={show ? 'Hide key' : 'Show key'}>
            {show ? <EyeOff /> : <Eye />}
          </button>
        </div>
        <Button type="submit" size="md" variant="primary" disabled={!key.trim() || busy}>
          {busy ? <Spinner /> : 'Save'}
        </Button>
        {hasKey && (
          <>
            <Button type="button" size="md" onClick={() => void ai.test(c.id)} disabled={busy}>
              Test
            </Button>
            <Button type="button" size="md" variant="ghost" aria-label={`Remove the ${c.label} key`} onClick={async () => (await confirmAction({ title: `Remove the ${c.label} key?`, body: 'It is deleted from this computer.', action: 'Remove', danger: true })) && void ai.saveKey(c.id, null)}>
              <Trash2 />
            </Button>
          </>
        )}
      </form>
      {result && <p className={cn('mt-1.5 text-[12px]', result.ok ? 'text-ok' : 'text-bad')}>{result.message}</p>}
      <p className="mt-1.5 text-[11.5px] text-fg-3">
        Saved in <span className="font-mono">{file ?? '.env.local'}</span>, readable only by you, never sent anywhere but {c.label.replace(/ API$/, '')}.
        {PRICES_AS_OF[c.kind] ? ` Prices as of ${PRICES_AS_OF[c.kind]}; a model released since shows “price unknown”.` : ''}
      </p>
      {hasKey && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim()) void ai.addModel(c.id, model.trim()).then(() => setModel(''));
          }}
        >
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Add a model by its id, if it isn’t listed" className={cn(input, 'flex-1 font-mono')} aria-label={`Model for ${c.label}`} />
          <Button type="submit" size="md" disabled={!model.trim()}>
            Add model
          </Button>
        </form>
      )}
    </div>
  );
}

function LocalRow({ c }: { c: ConnectionView }) {
  const loading = useAi((s) => s.loading);
  const site = c.id === 'ollama' ? 'https://ollama.com' : 'https://lmstudio.ai';
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-3" data-connection={c.id}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
          {c.label} <StatusBadge c={c} />
        </div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">
          {c.detail}{' '}
          {c.status !== 'ready' && (
            <a className="inline-flex items-center gap-0.5 text-human-fg hover:underline" href={site} target="_blank" rel="noreferrer">
              Get it <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
      {c.status === 'ready' ? (
        <Switch checked={!c.disabled} onCheckedChange={(v) => void ai.setOff(c.id, !v)} aria-label={`Use ${c.label}`} />
      ) : (
        <Button size="sm" variant="ghost" onClick={() => void ai.load(true)} disabled={loading} icon={loading ? <Spinner /> : <RefreshCw />}>
          Check again
        </Button>
      )}
    </div>
  );
}

function CustomRow({ c }: { c: ConnectionView }) {
  const busy = useAi((s) => !!s.busy[c.id]);
  const result = useAi((s) => s.results[c.id]);
  const [model, setModel] = useState('');
  return (
    <div className="px-3 py-3" data-connection={c.id}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
            {c.label} <StatusBadge c={c} />
          </div>
          <div className="mt-0.5 truncate text-[12px] text-fg-3">
            {c.baseUrl}
            {c.detail ? ` · ${c.detail}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" onClick={() => void ai.test(c.id)} disabled={busy || c.status !== 'ready'}>
            {busy ? <Spinner /> : 'Test'}
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Remove ${c.label}`} onClick={async () => (await confirmAction({ title: `Remove ${c.label}?`, body: 'Its key is deleted from this computer.', action: 'Remove', danger: true })) && void ai.remove(c.id)}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (model.trim()) void ai.addModel(c.id, model.trim()).then(() => setModel(''));
        }}
      >
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Add a model by its id (e.g. anthropic/claude-sonnet-5-5)" className={cn(input, 'flex-1 font-mono')} aria-label={`Model for ${c.label}`} />
        <Button type="submit" size="md" disabled={!model.trim()}>
          Add model
        </Button>
      </form>
      {result && <p className={cn('mt-1.5 text-[12px]', result.ok ? 'text-ok' : 'text-bad')}>{result.message}</p>}
    </div>
  );
}

function AddProvider() {
  const [preset, setPreset] = useState('openrouter');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const error = useAi((s) => s.error);
  const p = PRESETS.find((x) => x.id === preset)!;
  const options = PRESETS.filter((x) => x.id !== 'ollama' && x.id !== 'lmstudio').map((x) => ({ value: x.id, label: x.label }));
  return (
    <form
      className="space-y-2 px-3 py-3"
      data-add-provider
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await ai.add({ preset, baseUrl: preset === 'custom' ? baseUrl : undefined, key: key || undefined, models: model ? [model] : undefined });
        setBusy(false);
        if (ok) {
          setKey('');
          setModel('');
          setBaseUrl('');
        }
      }}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
        <Plus className="size-[14px] text-fg-3" /> Add a provider
      </div>
      <p className="text-[12px] leading-relaxed text-fg-3">{p.note ?? 'Any provider with an OpenAI-compatible API.'}</p>
      <div className="flex flex-wrap gap-2">
        <Select<string> value={preset} onChange={setPreset} options={options} className="w-[190px]" />
        {preset === 'custom' && <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className={cn(input, 'min-w-[220px] flex-1 font-mono')} aria-label="Provider address" />}
      </div>
      <div className="flex flex-wrap gap-2">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.keyUrl ? 'API key' : 'API key (if it needs one)'} autoComplete="off" className={cn(input, 'min-w-[200px] flex-1 font-mono')} aria-label="Provider key" />
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model id (optional)" className={cn(input, 'w-[200px] font-mono')} aria-label="Provider model" />
        <Button type="submit" size="md" variant="primary" disabled={busy || (p.keyUrl !== null && !key.trim()) || (preset === 'custom' && !baseUrl.trim())}>
          {busy ? <Spinner /> : 'Add'}
        </Button>
      </div>
      {p.keyUrl && (
        <a className="inline-flex items-center gap-0.5 text-[12px] text-human-fg hover:underline" href={p.keyUrl} target="_blank" rel="noreferrer">
          Get {/^[aeiou]/i.test(p.label) || /^x[A-Z]/.test(p.label) ? 'an' : 'a'} {p.label} key <ExternalLink className="size-3" />
        </a>
      )}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </form>
  );
}

export function AiSettings() {
  const state = useAiState();
  if (!state) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
        <Spinner /> Looking for AI on this computer…
      </div>
    );
  }
  const by = (auth: ConnectionView['auth'], ids?: string[]) => state.connections.filter((c) => c.auth === auth && (!ids || ids.includes(c.id)));
  const fake = state.connections.length && state.ready && !state.routes.code;
  return (
    <>
      <Title sub={<PrivacyNote />}>AI</Title>
      {fake ? <p className="mb-3 text-[12px] text-fg-3">The automated tests’ stand-in answers requests in this studio.</p> : null}
      {!state.ready && <ConnectAi state={state} />}
      <Section id="ai-plans" title="Your plans" sub="No API key needed: Saywright runs the official app on this computer, signed in with your own account. Requests count toward your plan’s limits, not a bill.">
        {by('subscription').map((c) => (
          <PlanRow key={c.id} c={c} />
        ))}
      </Section>
      <Section id="ai-keys" title="API keys" sub="Pay per use, straight to the provider. Prompt caching keeps repeated context cheap.">
        {by('key', ['anthropic', 'openai', 'gemini']).map((c) => (
          <KeyRow key={c.id} c={c} file={state.keysFile} />
        ))}
      </Section>
      <Section id="ai-local" title="On this computer" sub="Free and private. Changes need a model that can call tools (most recent ones can).">
        {by('local', ['ollama', 'lmstudio']).map((c) => (
          <LocalRow key={c.id} c={c} />
        ))}
      </Section>
      <Section title="Other providers" sub="OpenRouter, Groq, DeepSeek, Mistral, xAI, or any OpenAI-compatible address.">
        {state.connections
          .filter((c) => c.kind === 'compatible' && c.id !== 'ollama' && c.id !== 'lmstudio')
          .map((c) => (
            <CustomRow key={c.id} c={c} />
          ))}
        <AddProvider />
      </Section>
      {state.ready && (
        <div className="mt-8" data-ai-advanced>
          <h3 className="text-[14px] font-semibold text-fg">Advanced</h3>
          <p className="mt-1 max-w-[500px] text-[12.5px] leading-relaxed text-fg-3">Which model does each kind of work, and how hard it thinks. Automatic is a good start.</p>
          <Routes state={state} />
        </div>
      )}
    </>
  );
}

/** Nothing connected yet: the three ways to connect an AI come first, each with where it stands and one action. */
function ConnectAi({ state }: { state: AiState }) {
  const of = (auth: ConnectionView['auth']) => state.connections.filter((c) => c.auth === auth);
  const plans = of('subscription');
  const signIn = plans.filter((c) => c.status === 'needs-login');
  const local = of('local').filter((c) => c.id === 'ollama' || c.id === 'lmstudio');
  const ways = [
    {
      id: 'ai-plans',
      title: 'Use a plan you pay for',
      body: 'Claude, ChatGPT or Gemini, through their app on this computer, signed in as you. No extra bill.',
      status: signIn.length ? `${signIn.map((c) => SHORT[c.id] ?? c.label).join(', ')}: sign in needed` : plans.every((c) => c.status === 'missing') ? 'None installed yet' : 'Not ready yet',
      action: 'Set it up',
    },
    { id: 'ai-keys', title: 'Paste an API key', body: 'Anthropic, OpenAI or Google, billed per use by the provider. You can set a budget.', status: 'No key yet', action: 'Add a key' },
    {
      id: 'ai-local',
      title: 'Run a model on this computer',
      body: 'Free and private, with Ollama or LM Studio. Changes need a model that can use tools.',
      status: local.every((c) => c.status === 'missing') ? 'Not installed yet' : 'Not running',
      action: 'Set it up',
    },
  ];
  return (
    <section className="mb-7" data-connect-ai>
      <h3 className="text-[14px] font-semibold text-fg">Connect an AI</h3>
      <p className="mt-1 max-w-[520px] text-[12.5px] leading-relaxed text-fg-3">Quick edits work without one. For everything else, pick one of these:</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {ways.map((w) => (
          <div key={w.id} className="flex flex-col rounded-[12px] p-3 ring-1 ring-inset ring-line" data-way={w.id}>
            <div className="text-[13px] font-medium text-fg">{w.title}</div>
            <p className="mt-1 flex-1 text-[12px] leading-relaxed text-fg-3">{w.body}</p>
            <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-fg-3">
              <Dot tone="warn" /> {w.status}
            </div>
            <Button size="sm" variant="primary" className="mt-2.5 self-start" onClick={() => document.getElementById(w.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              {w.action}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ───────────────────────────── usage & budget ─────────────────────────────

const tokens = (t: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) => t.input + t.output + t.cacheRead + t.cacheWrite;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[10px] px-3 py-2.5 ring-1 ring-inset ring-line">
      <div className="text-[11.5px] text-fg-3">{label}</div>
      <div className="mt-0.5 text-[17px] font-semibold tabular-nums tracking-[-0.01em] text-fg">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] tabular-nums text-fg-3">{sub}</div>}
    </div>
  );
}

function Breakdown({ rows }: { rows: UsageRow[] }) {
  if (!rows.length) return <div className="px-3 py-4 text-[12px] text-fg-3">No AI calls this month yet.</div>;
  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-left text-fg-3">
          <th className="px-3 py-2 font-medium"> </th>
          <th className="px-2 py-2 text-right font-medium">Calls</th>
          <th className="px-2 py-2 text-right font-medium">Tokens</th>
          <th className="px-3 py-2 text-right font-medium">Cost</th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {rows.slice(0, 8).map((r) => (
          <tr key={r.key} className="border-t border-line">
            <td className="max-w-[260px] truncate px-3 py-1.5 text-fg">{r.label}</td>
            <td className="px-2 py-1.5 text-right text-fg-2">{r.calls}</td>
            <td className="px-2 py-1.5 text-right text-fg-2">{compact(tokens(r))}</td>
            <td className="px-3 py-1.5 text-right text-fg-2">{r.usd >= 0.005 ? usd(r.usd) : r.planUsd >= 0.005 ? `plan (${usd(r.planUsd)})` : r.unpriced === r.calls ? '—' : '$0'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Limit({ label, hint, value, onSave, unit }: { label: string; hint: string; value: number | null; onSave: (v: number | null) => void; unit: '$' | 'tokens' }) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  const commit = () => {
    const t = text.trim();
    const n = t === '' ? null : Number(t.replace(/[$,\s]/g, ''));
    if (n === null || (Number.isFinite(n) && n >= 0)) onSave(n);
    else setText(value == null ? '' : String(value));
  };
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-fg">{label}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">{hint}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {unit === '$' && <span className="text-[12.5px] text-fg-3">$</span>}
        <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} placeholder="No limit" aria-label={label} className={cn(input, 'w-[110px] text-right tabular-nums')} />
        {unit === 'tokens' && <span className="text-[12.5px] text-fg-3">tokens</span>}
      </div>
    </div>
  );
}

export function UsageSettings() {
  const state = useAiState();
  const [tab, setTab] = useState<'feature' | 'model' | 'app'>('feature');
  const u = state?.usage;
  const max = useMemo(() => Math.max(0.0001, ...(u?.days ?? []).map((d) => (d.usd > 0 ? d.usd : 0))), [u]);
  const maxTok = useMemo(() => Math.max(1, ...(u?.days ?? []).map((d) => d.tokens)), [u]);
  if (!u) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
        <Spinner /> Loading usage…
      </div>
    );
  }
  const byDollars = u.days.some((d) => d.usd > 0);
  return (
    <>
      <Title sub="Every AI call the studio makes is counted here: tokens, cost at list price, and what prompt caching saved. Plans and local models are counted too; they bill no dollars.">Usage and budget</Title>
      {u.status.message && (
        <div className={cn('mb-3 rounded-[10px] px-3 py-2 text-[12.5px] ring-1 ring-inset', u.status.level === 'over' ? 'text-bad ring-bad/40' : 'text-warn ring-warn/40')} data-budget-status={u.status.level}>
          {u.status.message} {u.status.level === 'over' && u.budget.mode === 'stop' ? 'AI requests are paused until you raise the limit or reset the count.' : ''}
        </div>
      )}
      {u.notice && (
        <div className="mb-3 rounded-[10px] px-3 py-2 text-[12.5px] text-warn ring-1 ring-inset ring-warn/40" data-budget-notice>
          {u.notice}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-usage>
        <Stat label="Today" value={usd(u.today.usd)} sub={`${compact(tokens(u.today))} tokens · ${u.today.calls} calls`} />
        <Stat label="This month" value={usd(u.month.usd)} sub={`${compact(tokens(u.month))} tokens · ${u.month.calls} calls${u.estimated ? ` (${u.estimated} estimated)` : ''}`} />
        <Stat label="Plan use this month" value={usd(u.month.planUsd)} sub="what it would cost through the API" />
        <Stat label="Saved by caching" value={usd(u.savedUsd)} sub="this month" />
      </div>
      <div className="mt-3 rounded-[10px] px-3 pb-2 pt-3 ring-1 ring-inset ring-line">
        <div className="flex h-16 items-end gap-[3px]" aria-label="Last 30 days">
          {u.days.map((d) => {
            const h = byDollars ? d.usd / max : d.tokens / maxTok;
            return <div key={d.date} title={`${d.date}: ${usd(d.usd)}, ${compact(d.tokens)} tokens`} className={cn('min-h-[2px] flex-1 rounded-t-[2px]', d.tokens ? 'bg-ai/70' : 'bg-line')} style={{ height: `${Math.max(3, h * 100)}%` }} />;
          })}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-fg-3">
          <span>30 days ago</span>
          <span>{byDollars ? 'Cost per day' : 'Tokens per day'}</span>
          <span>Today</span>
        </div>
      </div>
      <div className="mt-3 rounded-[10px] ring-1 ring-inset ring-line">
        <div className="flex items-center justify-between px-3 pt-2.5">
          <span className="text-[12px] font-semibold text-fg-2">This month by</span>
          <Segmented<'feature' | 'model' | 'app'>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'feature', label: 'Feature' },
              { value: 'model', label: 'Model' },
              { value: 'app', label: 'App' },
            ]}
          />
        </div>
        <Breakdown rows={tab === 'feature' ? u.byFeature : tab === 'model' ? u.byModel : u.byApp} />
      </div>
      <Section title="Budget" sub="Limits on what API keys may spend. A daily token limit also covers plans and local models.">
        <Limit label="Daily limit" hint="Dollars per day, across all API keys." value={u.budget.dailyUsd} unit="$" onSave={(v) => void ai.setBudget({ dailyUsd: v })} />
        <Limit label="Monthly limit" hint="Dollars per calendar month." value={u.budget.monthlyUsd} unit="$" onSave={(v) => void ai.setBudget({ monthlyUsd: v })} />
        <Limit label="Daily tokens" hint="All tokens per day, plans and local models included." value={u.budget.dailyTokens} unit="tokens" onSave={(v) => void ai.setBudget({ dailyTokens: v })} />
        <div className="flex items-center justify-between gap-4 px-3 py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-fg">At a limit</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">Warn from {Math.round(u.budget.warnAt * 100)}% and carry on, or stop: no request is sent that could go past a limit, until you raise it or reset.</div>
          </div>
          <Segmented<'warn' | 'stop'>
            value={u.budget.mode}
            onChange={(v) => void ai.setBudget({ mode: v })}
            options={[
              { value: 'warn', label: 'Warn' },
              { value: 'stop', label: 'Stop' },
            ]}
          />
        </div>
      </Section>
      <Section title="Reset">
        <div className="flex flex-wrap items-center gap-2 px-3 py-3">
          <Button size="sm" onClick={() => void ai.reset('today')}>
            Reset today’s count
          </Button>
          <Button size="sm" onClick={() => void ai.reset('month')}>
            Reset this month
          </Button>
          <Button size="sm" variant="ghost" onClick={async () => (await confirmAction({ title: 'Forget every AI call the studio recorded?', body: 'The counts and history start again from zero.', action: 'Forget them', danger: true })) && void ai.reset('all')}>
            Clear history
          </Button>
          {(u.resetAt.today || u.resetAt.month) && <span className="text-[11.5px] text-fg-3">Counting since {new Date(Math.max(u.resetAt.today ?? 0, u.resetAt.month ?? 0)).toLocaleString()}</span>}
        </div>
      </Section>
    </>
  );
}

// ───────────────────────────── other AI apps (MCP) ─────────────────────────────

export function McpSettings() {
  const state = useAiState();
  const [show, setShow] = useState(false);
  const mcp = state?.mcp;
  if (!mcp) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
        <Spinner /> Loading…
      </div>
    );
  }
  const auth = `Bearer ${mcp.token}`;
  const snippets: { app: string; where: string; text: string }[] = [
    { app: 'Claude Code', where: 'Run in a terminal', text: `claude mcp add --transport http saywright ${mcp.url} --header "Authorization: ${auth}"` },
    { app: 'Claude Desktop', where: 'Settings → Developer → Edit config (claude_desktop_config.json)', text: JSON.stringify({ mcpServers: { saywright: { command: mcp.stdio.command, args: mcp.stdio.args, ...(mcp.stdio.env ? { env: mcp.stdio.env } : {}) } } }, null, 2) },
    { app: 'Cursor', where: '~/.cursor/mcp.json', text: JSON.stringify({ mcpServers: { saywright: { url: mcp.url, headers: { Authorization: auth } } } }, null, 2) },
    { app: 'VS Code', where: '.vscode/mcp.json in your project', text: JSON.stringify({ servers: { saywright: { type: 'http', url: mcp.url, headers: { Authorization: auth } } } }, null, 2) },
    { app: 'Codex', where: '~/.codex/config.toml', text: `[mcp_servers.saywright]\nurl = "${mcp.url}"\nhttp_headers = { Authorization = "${auth}" }` },
  ];
  return (
    <>
      <Title sub="Claude Desktop, Claude Code, Cursor, VS Code and Codex can see what you point at here and propose changes you keep or undo in the studio. They connect to Saywright over MCP, on this computer only.">Use Saywright from other AI apps</Title>
      <Section title="Connection">
        <div className="space-y-2 px-3 py-3">
          <div className="text-[12px] text-fg-3">Address</div>
          <CopyText text={mcp.url} label="Copy the address" />
          <div className="flex items-center justify-between pt-1 text-[12px] text-fg-3">
            <span>Token (keep it private: it lets apps on this computer use Saywright)</span>
            <button className="inline-flex items-center gap-1 text-human-fg hover:underline [&_svg]:size-3" onClick={() => setShow(!show)}>
              {show ? <EyeOff /> : <Eye />} {show ? 'Hide' : 'Show'}
            </button>
          </div>
          <CopyText text={mcp.token} shown={show ? mcp.token : '•'.repeat(24)} label="Copy the token" />
        </div>
      </Section>
      <Section title="Set up an app" sub="Copy the settings for the app you use. They read what you selected or pinned (get_context), the code (read_file, search_code), your test sessions’ reports, and propose changes (propose_change).">
        {snippets.map((s) => (
          <div key={s.app} className="px-3 py-3" data-mcp-app={s.app}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] font-medium text-fg">{s.app}</div>
              <div className="flex items-center gap-1 text-[11.5px] text-fg-3">
                {s.where}
                <CopyButton text={s.text} label={`Copy the ${s.app} settings`} />
              </div>
            </div>
            <pre tabIndex={0} role="region" aria-label={`${s.app} settings`} className="mt-1.5 max-h-[140px] overflow-auto whitespace-pre-wrap break-all rounded-[8px] bg-sunken p-2.5 font-mono text-[11.5px] leading-relaxed text-fg-2">{show ? s.text : s.text.replaceAll(mcp.token, '•'.repeat(12))}</pre>
          </div>
        ))}
      </Section>
    </>
  );
}
