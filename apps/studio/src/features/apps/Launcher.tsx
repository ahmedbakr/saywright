/**
 * The studio's start screen: the apps you linked (open one, or one of its
 * addresses), and linking a new one from a folder, an address or a GitHub
 * repository. Shown when the studio opens (unless turned off) and from the
 * app menu in the top bar. Opening a local app starts its dev server here,
 * with its output, and says plainly why when it can't.
 */
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Box, ChevronDown, CircleHelp, Code2, FolderOpen, GitBranch, Globe, MoreHorizontal, Play, Plus, RotateCw, Settings2, Square, Trash2, TriangleAlert, X } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AppEnv, AppRun, LinkedApp } from '@shared/apps';
import { BRAND } from '@shared/brand';
import { Logo } from '@/components/Logo';
import { Button, IconButton } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { Badge, Dot, Spinner } from '@/components/ui/misc';
import { useModal } from '@/components/ui/modal';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { apps, useApps, type LinkTab } from '@/core/apps';
import { set, useStudio } from '@/core/store';
import { useSettings } from '@/core/settings';
import { cn } from '@/lib/cn';
import { ago, shortUrl } from '@/lib/format';
import { AiChip } from '../TopBar';
import { PrivacyNote } from '../Privacy';
import { LinkApp } from './LinkApp';

export const FRAMEWORK_LABEL: Record<string, string> = {
  vite: 'Vite',
  next: 'Next.js',
  cra: 'Create React App',
  astro: 'Astro',
  remix: 'Remix',
  'react-router': 'React Router',
  sveltekit: 'SvelteKit',
  nuxt: 'Nuxt',
  angular: 'Angular',
  gatsby: 'Gatsby',
  static: 'Static site',
  other: 'Web app',
};

export function AppIcon({ app, className }: { app: Pick<LinkedApp, 'name' | 'icon'>; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (app.icon && !broken) return <img src={app.icon} alt="" onError={() => setBroken(true)} className={cn('size-9 shrink-0 rounded-[9px] bg-white object-contain p-1 ring-1 ring-inset ring-line', className)} />;
  const letters = app.name
    .split(/[\s_-]+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-human-soft text-[13px] font-semibold text-human-fg ring-1 ring-inset ring-human-line/30', className)}>{letters || '·'}</span>;
}

function runTone(run?: AppRun): { tone: 'ok' | 'warn' | 'bad' | 'off'; text: string } | null {
  if (!run || run.status === 'stopped') return null;
  if (run.status === 'running') return { tone: 'ok', text: `Running${run.url ? ` · ${shortUrl(run.url)}` : ''}` };
  if (run.status === 'starting') return { tone: 'warn', text: 'Starting…' };
  if (run.status === 'installing') return { tone: 'warn', text: 'Installing…' };
  return { tone: 'bad', text: `Stopped with an error${run.exitCode != null ? ` (${run.exitCode})` : ''}` };
}

/** What keyboard focus starts on: the first way to link an app, or the first app's Open button. */
const firstAction = (root: HTMLElement | null) => root?.querySelector<HTMLElement>('[data-first-action]') ?? null;

export function Launcher() {
  const noApp = useStudio((s) => s.status !== null && !s.status.app);
  const shown = useApps((s) => s.launcher);
  const active = useApps((s) => s.active);
  const list = useApps((s) => s.apps);
  const loaded = useApps((s) => s.loaded);
  const pref = useApps((s) => s.launcherPref);
  const linking = useApps((s) => s.linking);
  const open = shown || noApp;
  // A real modal: the studio behind it is inert until an app is open.
  const root = useRef<HTMLDivElement | null>(null);
  const layer = useModal(open, {
    onEscape: active ? () => apps.hide() : undefined,
    // Until the list has loaded, the screen itself: then its first action (below), not whatever comes first.
    initialFocus: () => firstAction(root.current) ?? root.current,
    returnFocus: () => document.querySelector<HTMLElement>('[data-app-switcher]'),
  });
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    root.current = el;
    layer(el);
  }, [layer]);
  // The list loads after the screen shows: then focus its first action.
  useEffect(() => {
    if (open && loaded && root.current && document.activeElement === root.current) firstAction(root.current)?.focus();
  }, [open, loaded]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="launcher"
          ref={setRoot}
          tabIndex={-1}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-bg outline-none"
          role="dialog"
          aria-modal="true"
          aria-label="Your apps"
          data-launcher
        >
          <header className="flex h-[54px] shrink-0 items-center gap-2.5 border-b border-line bg-panel px-4">
            <Logo className="size-[24px]" />
            <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">{BRAND.name}</span>
            <span className="hidden text-[12.5px] text-fg-3 md:inline">· {BRAND.tagline}</span>
            {/* Before any app is linked: who answers AI requests, help and settings (budget, privacy, voice). */}
            <div className="ms-auto flex items-center gap-1">
              <AiChip />
              <span className="mx-1 h-4 w-px bg-line-strong" />
              <Tip label="Phrases and shortcuts">
                <IconButton onClick={() => set({ overlay: 'help' })} aria-label="Help">
                  <CircleHelp />
                </IconButton>
              </Tip>
              <Tip label="Settings">
                <IconButton onClick={() => set({ overlay: 'settings', settingsTab: 'general' })} aria-label="Settings">
                  <Settings2 />
                </IconButton>
              </Tip>
              {active && (
                <Tip label="Back to the open app" kbd="Esc">
                  <IconButton onClick={() => apps.hide()} aria-label="Back to the open app">
                    <X />
                  </IconButton>
                </Tip>
              )}
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1080px] flex-1 px-5 pb-16 pt-9">
            {!loaded ? (
              <div className="flex justify-center pt-24">
                <Spinner className="size-5 text-fg-3" />
              </div>
            ) : list.length ? (
              <>
                <div className="mb-5 flex flex-wrap items-end gap-3">
                  <div>
                    <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">Your apps</h1>
                    <p className="mt-1 text-[13px] text-fg-3">Pick up where you left off, or link another app. Each keeps its own sessions, changes and settings.</p>
                  </div>
                  <Button className="ms-auto" variant="primary" size="md" icon={<Plus />} onClick={() => apps.setLinking('folder')} data-link-app>
                    Link an app
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((a, i) => (
                    <AppCard key={a.id} app={a} current={a.id === active} first={i === 0} />
                  ))}
                </div>
                {!list.some((a) => a.sample) && (
                  <button onClick={() => void apps.sample()} className="mt-4 text-[12.5px] text-fg-3 underline decoration-line-strong underline-offset-2 hover:text-fg-2">
                    Try the sample shop (it has a real bug to find)
                  </button>
                )}
              </>
            ) : (
              <Welcome onLink={(how) => apps.setLinking(how)} />
            )}
          </main>
          {loaded && (
            <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-5 py-3 text-[12px] text-fg-3">
              <label className="flex items-center gap-2">
                <Switch checked={pref} onCheckedChange={(on) => void apps.setLauncherPref(on)} aria-label="Show this list when the studio starts" />
                Show this list when the studio starts
              </label>
              <PrivacyNote className="ms-auto max-w-[680px] text-[12px]" />
            </footer>
          )}
          <LinkApp open={!!linking} start={linking ?? 'folder'} onClose={() => apps.setLinking(null)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Welcome({ onLink }: { onLink: (how: LinkTab) => void }) {
  // The quick-start tour follows on the app: say so, the first time.
  const unseen = useStudio((s) => s.status?.tourSeen === false);
  const onboarded = useSettings((s) => s.onboarded);
  const touring = unseen && !onboarded;
  return (
    <div className="mx-auto max-w-[760px] pt-6 text-center" data-welcome>
      <Logo className="mx-auto size-12" />
      <h1 className="mt-5 text-[26px] font-semibold tracking-[-0.02em] text-fg">Welcome to {BRAND.name}</h1>
      <p className="mx-auto mt-2 max-w-[520px] text-[14px] leading-relaxed text-fg-2">Link the app you are building. Point at anything in it, say or type what to change, and keep or undo the result.</p>
      <div className="mt-8 grid gap-3 text-start sm:grid-cols-3">
        <Choice icon={<FolderOpen />} title="A folder on this computer" onClick={() => onLink('folder')} first>
          Any web app: Vite, Next.js, Astro, Angular, plain HTML. The studio starts it for you.
        </Choice>
        <Choice icon={<Globe />} title="An address" onClick={() => onLink('url')}>
          Already running locally, or deployed (staging, production): test, record and audit it.
        </Choice>
        <Choice icon={<GitBranch />} title="A GitHub repository" onClick={() => onLink('github')}>
          Cloned here, installed and started, ready to change.
        </Choice>
      </div>
      <button onClick={() => void apps.sample()} className="mt-8 inline-flex items-center gap-1.5 text-[13px] font-medium text-human-fg hover:underline" data-try-sample>
        Or try the sample shop first <ArrowRight className="size-3.5" />
      </button>
      {touring && <p className="mt-2 text-[12.5px] text-fg-3">A one-minute tour starts once your app is open.</p>}
    </div>
  );
}

function Choice({ icon, title, children, onClick, first }: { icon: ReactNode; title: string; children: ReactNode; onClick: () => void; first?: boolean }) {
  return (
    <button onClick={onClick} data-first-action={first || undefined} className="group flex flex-col items-start rounded-[14px] bg-raised p-4 text-start ring-1 ring-inset ring-line transition hover:ring-line-strong">
      <span className="flex size-9 items-center justify-center rounded-[9px] bg-sunken text-fg-2 ring-1 ring-inset ring-line [&_svg]:size-[17px] group-hover:text-fg">{icon}</span>
      <span className="mt-3 block text-[13.5px] font-semibold text-fg">{title}</span>
      <span className="mt-1 block text-[12.5px] leading-relaxed text-fg-3">{children}</span>
    </button>
  );
}

function AppCard({ app, current, first }: { app: LinkedApp; current: boolean; first: boolean }) {
  const run = useApps((s) => s.runs[app.id]);
  const busy = useApps((s) => s.opening?.id === app.id && !s.opening.error);
  const state = runTone(run);
  // Open, but its dev server stopped: going back to it starts it again.
  const stopped = run?.status === 'crashed';
  const env = app.envs.find((e) => e.id === app.env) ?? app.envs[0];
  return (
    <article className={cn('flex flex-col rounded-[14px] bg-raised p-4 ring-1 ring-inset transition-shadow', current ? 'ring-human-line/60' : 'ring-line hover:ring-line-strong')} data-app={app.id}>
      <div className="flex items-start gap-3">
        <AppIcon app={app} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[14px] font-semibold text-fg">{app.name}</h2>
            {current && <Badge tone="human">Open</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-fg-3">
            {app.framework && <span>{FRAMEWORK_LABEL[app.framework] ?? app.framework}</span>}
            {!app.root && <span>· address only</span>}
            {app.sample && <span>· sample</span>}
          </div>
        </div>
        <AppMenu app={app} run={run} />
      </div>
      <div className="mt-3 space-y-1">
        {app.envs.map((e) => (
          <EnvRow key={e.id} app={app} env={e} chosen={e.id === env.id} />
        ))}
      </div>
      {state && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-fg-3" data-run={run?.status}>
          <Dot tone={state.tone} pulse={state.tone === 'warn'} />
          {state.text}
        </div>
      )}
      <div className="mt-auto flex items-center gap-2 pt-4">
        <span className="text-[11.5px] text-fg-3">{current ? 'Open now' : `Opened ${ago(app.openedAt)}`}</span>
        <Button
          className="ms-auto"
          variant={current && !stopped ? 'secondary' : 'primary'}
          size="sm"
          icon={busy ? <Spinner /> : <Play />}
          disabled={busy}
          onClick={() => (current && !stopped ? apps.hide() : void apps.open(app.id))}
          data-open-app
          data-first-action={first || undefined}
        >
          {current ? (stopped ? 'Start it again' : 'Back to it') : 'Open'}
        </Button>
      </div>
    </article>
  );
}

function EnvRow({ app, env, chosen }: { app: LinkedApp; env: AppEnv; chosen: boolean }) {
  return (
    <button
      onClick={() => void apps.open(app.id, env.id)}
      className={cn('flex w-full items-center gap-2 rounded-[8px] px-2 py-1 text-start text-[12px] hover:bg-hover', chosen ? 'text-fg-2' : 'text-fg-3')}
      title={`Open ${env.label}: ${env.url}`}
      data-env={env.id}
    >
      {env.kind === 'local' ? <Code2 className="size-3.5 shrink-0" /> : <Globe className="size-3.5 shrink-0" />}
      <span className="w-[74px] shrink-0 font-medium">{env.label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{shortUrl(env.url)}</span>
      {env.connection === 'proxy' && <span className="shrink-0 text-[10.5px] text-fg-3">via proxy</span>}
    </button>
  );
}

function AppMenu({ app, run }: { app: LinkedApp; run?: AppRun }) {
  const [editing, setEditing] = useState<null | 'name' | 'start' | 'env'>(null);
  const running = run?.status === 'running' || run?.status === 'starting';
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <IconButton size="sm" aria-label={`More for ${app.name}`}>
            <MoreHorizontal />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className="z-[60] min-w-[230px] rounded-[10px] bg-raised p-1 shadow-pop">
            <Item icon={<Globe />} onSelect={() => setEditing('env')}>
              Add an address (staging, production)…
            </Item>
            <Item icon={<Box />} onSelect={() => setEditing('name')}>
              Rename…
            </Item>
            {app.root && (
              <Item icon={<Play />} onSelect={() => setEditing('start')}>
                Dev command…
              </Item>
            )}
            {app.root && app.packageManager && (
              <Item icon={<RotateCw />} onSelect={() => void apps.install(app.id)}>
                Install dependencies ({app.packageManager} install)
              </Item>
            )}
            {running && (
              <Item icon={<Square />} onSelect={() => void apps.stop(app.id)}>
                Stop its dev server
              </Item>
            )}
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <Item
              icon={<Trash2 />}
              danger
              onSelect={async () => {
                if (await confirmAction({ title: `Remove ${app.name} from the studio?`, body: 'Its code, sessions and reports stay where they are on this computer. You can link it again at any time.', action: 'Remove', danger: true })) void apps.remove(app.id);
              }}
            >
              Remove from the studio
            </Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {editing && <EditApp app={app} what={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function Item({ icon, children, onSelect, danger }: { icon: ReactNode; children: ReactNode; onSelect: () => void; danger?: boolean }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn('flex h-8 cursor-default items-center gap-2 rounded-[7px] px-2 text-[12.5px] text-fg outline-none data-[highlighted]:bg-hover [&_svg]:size-[14px] [&_svg]:text-fg-3', danger && 'text-bad [&_svg]:text-bad')}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  );
}

/** A small inline form over the card: rename, dev command, or another address. */
function EditApp({ app, what, onClose }: { app: LinkedApp; what: 'name' | 'start' | 'env'; onClose: () => void }) {
  const [value, setValue] = useState(what === 'name' ? app.name : what === 'start' ? (app.start ?? '') : '');
  const [label, setLabel] = useState('Production');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (what === 'name') await apps.update(app.id, { name: value });
      else if (what === 'start') await apps.update(app.id, { start: value.trim() || null });
      else await apps.addEnv(app.id, value, label);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const layer = useModal(true, { onEscape: onClose });
  const id = useId();
  return (
    <div ref={layer} className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
        className="w-[min(440px,100%)] rounded-[14px] bg-panel p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3 id={`${id}-title`} className="text-[14px] font-semibold text-fg">{what === 'name' ? `Rename ${app.name}` : what === 'start' ? 'Dev command' : `Another address for ${app.name}`}</h3>
        <p id={`${id}-hint`} className="mt-1 text-[12.5px] text-fg-3">
          {what === 'start' ? `Run in ${app.root} to start it. Leave empty if you start it yourself.` : what === 'env' ? 'A staging or production address: open it to test, record and audit the deployed app.' : 'How it is listed here.'}
        </p>
        {what === 'env' && (
          <div className="mt-3 flex gap-1.5">
            {['Staging', 'Production', 'Preview'].map((l) => (
              <button key={l} type="button" onClick={() => setLabel(l)} className={cn('h-7 rounded-full px-3 text-[12px] ring-1 ring-inset', label === l ? 'bg-fg text-inverse ring-fg' : 'text-fg-2 ring-line hover:bg-hover')}>
                {l}
              </button>
            ))}
          </div>
        )}
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={what === 'env' ? 'https://example.com' : what === 'start' ? 'npm run dev' : ''}
          spellCheck={false}
          className={cn('mt-3 h-9 w-full rounded-[8px] bg-sunken px-3 text-[13px] text-fg outline-none ring-1 ring-inset ring-line-strong focus:ring-human-line', what !== 'name' && 'font-mono text-[12.5px]')}
        />
        {error && <p className="mt-2 text-[12px] text-bad">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || (what !== 'start' && !value.trim())} icon={busy ? <Spinner /> : undefined}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Opening an app: starting its dev server, with its output; and why, when it didn't open. */
export function OpeningCard() {
  const opening = useApps((s) => s.opening);
  const list = useApps((s) => s.apps);
  const run = useApps((s) => (s.opening ? s.runs[s.opening.id] : undefined));
  const [log, setLog] = useState(false);
  const app = list.find((a) => a.id === opening?.id);
  const failed = !!opening?.error;
  const cancel = () => {
    if (app && !failed) void apps.stop(app.id);
    apps.dismissOpening();
  };
  const layer = useModal(!!opening, { onEscape: failed || app ? cancel : undefined });
  const id = useId();
  if (!opening) return null;
  const name = app?.name ?? (opening.id === 'sample' ? 'the sample shop' : 'the app');
  const lines = run?.log ?? [];
  return (
    <div ref={layer} className="fixed inset-0 z-[65] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" data-opening={failed ? 'failed' : 'busy'}>
      <div role={failed ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-what`} className="w-[min(560px,100%)] overflow-hidden rounded-[14px] bg-panel shadow-pop">
        <div className="flex items-start gap-3 p-5">
          {failed ? <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" /> : <Spinner className="mt-0.5 size-5 shrink-0 text-human" />}
          <div className="min-w-0 flex-1">
            <h3 id={`${id}-title`} className="text-[14.5px] font-semibold text-fg">{failed ? `${name} didn’t open` : `${opening.step === 'Opening' ? 'Opening' : opening.step} ${opening.step.startsWith('Starting the') || opening.step.startsWith('Installing') ? '' : name}`.trim()}</h3>
            <p id={`${id}-what`} className={cn('mt-1 whitespace-pre-line text-[12.5px] leading-relaxed', failed ? 'text-fg-2' : 'shimmer-text')}>
              {failed ? opening.error?.split('\n')[0] : run?.status === 'starting' ? `Running “${run.command}” and waiting for it to answer…` : run?.status === 'installing' ? `Running “${run.command}”…` : 'Connecting…'}
            </p>
          </div>
        </div>
        {lines.length > 1 && (
          <div className="border-t border-line">
            <button onClick={() => setLog(!log)} className="flex w-full items-center gap-1.5 px-5 py-2 text-start text-[12px] text-fg-3 hover:text-fg-2">
              <ChevronDown className={cn('size-3.5 transition-transform', (log || failed) && 'rotate-180')} />
              Its output
            </button>
            {(log || failed) && (
              <pre tabIndex={0} role="region" aria-label="Its output" className="max-h-[220px] overflow-auto bg-sunken px-5 py-3 font-mono text-[11.5px] leading-relaxed text-fg-2" dir="ltr" data-run-log>
                {lines.slice(-40).join('\n')}
              </pre>
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-sunken/40 px-5 py-3">
          {failed ? (
            <>
              <Button variant="ghost" onClick={() => apps.dismissOpening()}>
                Close
              </Button>
              {opening.code === 'needs-install' && app && (
                <Button
                  variant="primary"
                  icon={<RotateCw />}
                  onClick={async () => {
                    if (await apps.install(app.id)) void apps.open(app.id, opening.env || undefined);
                  }}
                >
                  Install dependencies and open
                </Button>
              )}
              {opening.code !== 'needs-install' && app && (
                <Button variant="primary" icon={<RotateCw />} onClick={() => void apps.open(app.id, opening.env || undefined)}>
                  Try again
                </Button>
              )}
            </>
          ) : (
            app && (
              <Button variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** Switching away from an app with changes waiting: keep them or undo them first. */
export function PendingSwitch() {
  const pending = useApps((s) => s.pending);
  const layer = useModal(!!pending, { onEscape: () => apps.dismissOpening() });
  const id = useId();
  if (!pending) return null;
  return (
    <div ref={layer} className="fixed inset-0 z-[66] flex items-center justify-center bg-black/45 p-4" data-pending-switch>
      <div role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-what`} className="w-[min(460px,100%)] rounded-[14px] bg-panel p-5 shadow-pop">
        <h3 id={`${id}-title`} className="text-[14.5px] font-semibold text-fg">Keep or undo first?</h3>
        <p id={`${id}-what`} className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">{pending.message} They stay in its code if you keep them.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => apps.dismissOpening()}>
            Cancel
          </Button>
          <Button onClick={() => void apps.open(pending.id, pending.env, 'undo')}>Undo and switch</Button>
          <Button variant="primary" onClick={() => void apps.open(pending.id, pending.env, 'keep')}>
            Keep and switch
          </Button>
        </div>
      </div>
    </div>
  );
}
