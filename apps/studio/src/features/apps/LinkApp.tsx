/**
 * Linking an app: from a folder on this computer (picked from a folder list),
 * from an address (local or deployed), or from a GitHub repository (cloned
 * here). The studio says what it found (framework, dev command, address, how
 * it will show it) and lets each be changed before linking.
 */
import { ArrowUp, Check, CornerDownLeft, Folder, FolderGit2, FolderOpen, GitBranch, Globe, Home, TriangleAlert } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppProbe, FolderListing, LinkedApp } from '@shared/apps';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Spinner } from '@/components/ui/misc';
import { apps, useApps, type LinkTab } from '@/core/apps';
import { cn } from '@/lib/cn';
import { AppIcon, FRAMEWORK_LABEL } from './Launcher';

export type { LinkTab };

/** `start`: the way of linking it opens on. */
export function LinkApp({ open, onClose, start = 'folder', attachTo = null }: { open: boolean; onClose: () => void; start?: LinkTab; attachTo?: LinkedApp | null }) {
  const [tab, setTab] = useState<LinkTab>(start);
  const [probe, setProbe] = useState<AppProbe | null>(null);
  useEffect(() => {
    if (!open) setProbe(null);
    else setTab(start);
  }, [open, start]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Link an app" showTitle position="top" className="w-[min(720px,calc(100vw-32px))]">
      <Tabs.Root
        value={tab}
        onValueChange={(v) => {
          setTab(v as LinkTab);
          setProbe(null);
        }}
        className="flex min-h-0 flex-col"
        data-link-dialog
      >
        <Tabs.List aria-label="Where the app is" className="flex shrink-0 items-center gap-1 border-b border-line px-4 pt-1.5">
          <TabButton value="folder" icon={<FolderOpen />}>
            Folder on this computer
          </TabButton>
          <TabButton value="url" icon={<Globe />}>
            Address
          </TabButton>
          <TabButton value="github" icon={<GitBranch />}>
            GitHub
          </TabButton>
        </Tabs.List>
        <Tabs.Content value={tab} className="min-h-0 flex-1 overflow-y-auto p-5 outline-none">
          {/* Another app picked from the one shown (a monorepo's) gets its own name, command and address, not the first's. */}
          {probe ? (
            <Summary key={`${probe.root ?? ''}|${probe.url ?? ''}`} probe={probe} cloned={tab === 'github'} attachTo={attachTo} onBack={() => setProbe(null)} onProbe={setProbe} onLinked={onClose} />
          ) : tab === 'folder' ? (
            <FolderPicker onProbe={setProbe} />
          ) : tab === 'url' ? (
            <AddressForm onProbe={setProbe} />
          ) : (
            <GithubForm onProbe={setProbe} />
          )}
        </Tabs.Content>
      </Tabs.Root>
    </Dialog>
  );
}

function TabButton({ value, icon, children }: { value: LinkTab; icon: ReactNode; children: ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        'relative flex h-9 items-center gap-1.5 px-2.5 text-[12.5px] font-medium text-fg-3 transition-colors hover:text-fg-2 [&_svg]:size-[14px]',
        'data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:bg-fg',
      )}
    >
      {icon}
      {children}
    </Tabs.Trigger>
  );
}

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

function FolderPicker({ onProbe }: { onProbe: (p: AppProbe) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [path, setPath] = useState('');
  const { busy, error, run } = useAsync();
  // Only the folder asked for last is shown, and the box keeps what was typed in it meanwhile: the first listing,
  // coming late, replaces neither.
  const asked = useRef(0);
  const typed = useRef('');
  const go = async (to?: string) => {
    const n = ++asked.current;
    const box = typed.current;
    const l = await run(() => apps.folders(to));
    if (l && n === asked.current) {
      setListing(l);
      if (typed.current === box) setPath((typed.current = l.path));
    }
  };
  useEffect(() => {
    void go();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the first listing, once, when the picker opens
  }, []);
  const use = async (folder: string) => {
    const p = await run(() => apps.probeFolder(folder));
    if (p) onProbe(p);
  };
  const folders = listing ? [...listing.folders].sort((a, b) => Number(b.app) - Number(a.app)) : [];
  return (
    <div className="space-y-3" data-folder-picker>
      <p className="text-[12.5px] leading-relaxed text-fg-2">Pick your app’s own folder: the one with its package.json, or its index.html. Folders marked “app” have one.</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void go(path);
        }}
      >
        <input
          value={path}
          onChange={(e) => setPath((typed.current = e.target.value))}
          spellCheck={false}
          placeholder="/path/to/your/app"
          className="h-9 min-w-0 flex-1 rounded-[8px] bg-sunken px-3 font-mono text-[12.5px] text-fg outline-none ring-1 ring-inset ring-line-strong focus:ring-human-line"
          aria-label="Folder"
        />
        <Button type="submit" size="md" icon={<CornerDownLeft />} disabled={busy}>
          Go
        </Button>
        {/* The folder typed, when it differs from the one listed: what the box says is what is used. */}
        <Button type="button" size="md" variant="primary" icon={<Check />} disabled={busy || (!listing && !path.trim())} onClick={() => void use(path.trim() || listing!.path)} data-use-folder>
          Use this folder
        </Button>
      </form>
      {listing && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {listing.places.map((p) => (
              <button key={p.path} onClick={() => void go(p.path)} className="inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11.5px] text-fg-2 ring-1 ring-inset ring-line hover:bg-hover">
                {p.label === 'Home' ? <Home className="size-3" /> : <Folder className="size-3" />}
                {p.label}
              </button>
            ))}
          </div>
          <div className="overflow-hidden rounded-[10px] ring-1 ring-inset ring-line">
            {listing.parent && (
              <FolderRow icon={<ArrowUp />} name=".." onOpen={() => void go(listing.parent!)} />
            )}
            {folders.length === 0 && <p className="px-3 py-6 text-center text-[12.5px] text-fg-3">No folders here. Type your app’s path above, or go up.</p>}
            <div className="max-h-[300px] overflow-y-auto">
              {folders.map((f) => (
                <FolderRow key={f.path} icon={f.app ? <FolderGit2 /> : <Folder />} name={f.name} app={f.app} onOpen={() => void go(f.path)} onUse={f.app ? () => void use(f.path) : undefined} />
              ))}
            </div>
          </div>
        </>
      )}
      {busy && <Spinner className="text-fg-3" />}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </div>
  );
}

function FolderRow({ icon, name, app, onOpen, onUse }: { icon: ReactNode; name: string; app?: boolean; onOpen: () => void; onUse?: () => void }) {
  return (
    <div className="group flex items-center gap-2 border-b border-line px-3 py-1.5 last:border-0 hover:bg-hover" data-folder={name}>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-start text-[12.5px] text-fg [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:text-fg-3">
        {icon}
        <span className="truncate">{name}</span>
        {app && <Badge tone="human">app</Badge>}
      </button>
      {onUse && (
        <Button size="xs" variant="ghost" onClick={onUse} aria-label={`Use ${name}`}>
          Use
        </Button>
      )}
    </div>
  );
}

function AddressForm({ onProbe }: { onProbe: (p: AppProbe) => void }) {
  const [url, setUrl] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() => apps.probeUrl(url));
        if (p) onProbe(p);
      }}
    >
      <p className="text-[12.5px] leading-relaxed text-fg-2">An app already running on this computer (http://localhost:3000), or a deployed one (staging, production). The studio shows it through a small local proxy, so nothing in it needs to change.</p>
      <label htmlFor="link-address" className="block text-[12px] font-medium text-fg-2">
        Address
      </label>
      <div className="flex gap-2">
        <input
          id="link-address"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://localhost:3000 or https://example.com"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 rounded-[8px] bg-sunken px-3 font-mono text-[12.5px] text-fg outline-none ring-1 ring-inset ring-line-strong focus:ring-human-line"
          data-url-input
        />
        <Button type="submit" variant="primary" size="md" disabled={busy || !url.trim()} icon={busy ? <Spinner /> : undefined}>
          Check
        </Button>
      </div>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </form>
  );
}

function GithubForm({ onProbe }: { onProbe: (p: AppProbe) => void }) {
  const cloneDir = useApps((s) => s.cloneDir);
  const log = useApps((s) => s.cloneLog);
  const [repo, setRepo] = useState('');
  const [dir, setDir] = useState(cloneDir);
  const { busy, error, run } = useAsync();
  useEffect(() => setDir((d) => d || cloneDir), [cloneDir]);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() => apps.clone(repo, dir));
        if (p) onProbe(p);
      }}
    >
      <p className="text-[12.5px] leading-relaxed text-fg-2">Cloned onto this computer to work on. Private repositories work when the GitHub CLI is signed in (gh auth login) or git already has access.</p>
      <label className="block text-[12px] font-medium text-fg-2">
        Repository
        <input
          autoFocus
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/name or https://github.com/owner/name"
          spellCheck={false}
          className="mt-1 h-9 w-full rounded-[8px] bg-sunken px-3 font-mono text-[12.5px] font-normal text-fg outline-none ring-1 ring-inset ring-line-strong focus:ring-human-line"
        />
      </label>
      <label className="block text-[12px] font-medium text-fg-2">
        Clone into
        <input
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          spellCheck={false}
          className="mt-1 h-8 w-full rounded-[8px] bg-sunken px-3 font-mono text-[12px] font-normal text-fg-2 outline-none ring-1 ring-inset ring-line focus:ring-human-line"
        />
      </label>
      <Button type="submit" variant="primary" size="md" disabled={busy || !repo.trim()} icon={busy ? <Spinner /> : <GitBranch />}>
        {busy ? 'Cloning…' : 'Clone'}
      </Button>
      {(busy || error) && log.length > 0 && (
        <pre tabIndex={0} role="region" aria-label="Clone output" className="max-h-[160px] overflow-auto rounded-[8px] bg-sunken px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-3" dir="ltr">
          {log.slice(-12).join('\n')}
        </pre>
      )}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </form>
  );
}

/** What was found, editable, then linked (and opened). `cloned`: code just downloaded from GitHub, whose own commands opening it runs. */
function Summary({ probe, cloned, attachTo, onBack, onProbe, onLinked }: { probe: AppProbe; cloned: boolean; attachTo: LinkedApp | null; onBack: () => void; onProbe: (p: AppProbe) => void; onLinked: () => void }) {
  const local = !!probe.root;
  // Nothing here the studio can start (no dev script, not a static site): its address would only be a guess.
  const notAnApp = local && probe.framework === 'other' && !probe.start;
  const [name, setName] = useState(probe.name);
  const [start, setStart] = useState(probe.start ?? '');
  const [url, setUrl] = useState(notAnApp ? '' : (probe.url ?? ''));
  const { busy, error, run } = useAsync();
  const inside = useAppsInside(notAnApp && !probe.candidates?.length ? probe.root : null);
  const suggestions = probe.candidates?.length ? probe.candidates : inside;
  const runnable = local ? probe.framework === 'static' || !!start.trim() || !!url.trim() : !!url.trim();
  const pick = async (path: string) => {
    const p = await run(() => apps.probeFolder(path));
    if (p) onProbe(p);
  };
  // The folder of an app linked by its address: that app's, keeping its name and addresses.
  const attach = attachTo && local && !attachTo.root ? attachTo : null;
  const link = async () => {
    const ok = await run(() => (attach ? apps.attachFolder(attach.id, probe) : apps.link(probe, { name: name.trim() || probe.name, start: local ? start.trim() || null : undefined, url: url.trim() || undefined })));
    if (ok) onLinked();
  };
  return (
    <div className="space-y-4" data-probe>
      <div className="flex items-start gap-3">
        <AppIcon app={{ name, icon: probe.icon }} className="size-11" />
        <div className="min-w-0 flex-1">
          <input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-full rounded-[7px] bg-transparent px-1.5 text-[16px] font-semibold text-fg outline-none ring-inset hover:ring-1 hover:ring-line focus:ring-1 focus:ring-human-line" aria-label="Name" />
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 px-1.5 text-[12px] text-fg-3">
            {probe.framework && !notAnApp && <Badge>{FRAMEWORK_LABEL[probe.framework] ?? probe.framework}</Badge>}
            {probe.packageManager && !notAnApp && <span>{probe.packageManager}</span>}
            {probe.root && <span className="truncate font-mono text-[11.5px]">{probe.root}</span>}
            {!probe.root && probe.title && <span className="truncate">{probe.title}</span>}
          </div>
        </div>
      </div>
      {notAnApp && (
        <div className="flex items-start gap-2 rounded-[10px] bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn" role="status" data-not-an-app>
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            {probe.notes[0] ?? 'This folder isn’t an app the studio can start.'}
            {suggestions.length > 0 && ' Did you mean one of the apps inside it?'}
          </span>
        </div>
      )}
      {suggestions.length > 0 && (
        <div data-suggested-apps>
          <div className="mb-1.5 text-[12px] font-medium text-fg-2">{probe.candidates?.length ? 'Apps in this repository' : 'Apps in this folder'}</div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((c) => (
              <Button key={c.path} size="sm" icon={<FolderGit2 />} onClick={() => void pick(c.path)}>
                {c.name}
                {c.framework && <span className="text-fg-3">· {FRAMEWORK_LABEL[c.framework] ?? c.framework}</span>}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {local && (
          <Field label="Dev command" hint={probe.framework === 'static' ? 'Optional: a command that serves it. Empty: the studio serves this folder itself.' : 'Run in its folder to start it. Empty: you start it yourself.'}>
            <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="npm run dev" spellCheck={false} className="h-8 w-full rounded-[8px] bg-sunken px-2.5 font-mono text-[12.5px] text-fg outline-none ring-1 ring-inset ring-line-strong focus:ring-human-line" data-start-input />
          </Field>
        )}
        <Field label="Address" hint={probe.framework === 'static' && !start.trim() ? 'The studio serves this folder itself, at an address it picks.' : local ? 'Where its dev server usually answers. The studio follows it if it moves.' : 'Opened in the studio through its proxy.'}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={probe.framework === 'static' && !start.trim() ? 'Picked when it is served' : 'http://localhost:5173'} spellCheck={false} className="h-8 w-full rounded-[8px] bg-sunken px-2.5 font-mono text-[12.5px] text-fg outline-none ring-1 ring-inset ring-line-strong focus:ring-human-line" data-url-field />
        </Field>
      </div>
      {probe.notes.length > (notAnApp ? 1 : 0) && (
        <ul className="space-y-1.5 rounded-[10px] bg-sunken/60 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
          {probe.notes.slice(notAnApp ? 1 : 0).map((n) => (
            <li key={n} className="flex gap-2">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-fg-3" />
              {n}
            </li>
          ))}
        </ul>
      )}
      {probe.needsInstall && !cloned && (
        <p className="flex items-start gap-2 rounded-[10px] bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          Its dependencies aren’t installed. Installing runs the project’s install scripts: only do it for code you trust.
        </p>
      )}
      {cloned && local && (
        <p className="flex items-start gap-2 rounded-[10px] bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn" data-runs-code>
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Opening it runs this repository’s own commands on your computer{probe.needsInstall ? ': its install scripts, then ' : ': '}
            <code className="font-mono">{start.trim() || 'nothing until you start it'}</code>. Only open code you trust.
          </span>
        </p>
      )}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        {!runnable && !attach && <span className="ms-auto text-[12px] text-fg-3">Needs a dev command or an address</span>}
        <Button className={cn((runnable || attach) && 'ms-auto')} variant="primary" size="md" disabled={busy || (attach ? notAnApp : !runnable)} icon={busy ? <Spinner /> : <Check />} onClick={() => void link()} data-link-confirm>
          {attach ? `Make it ${attach.name}’s code` : cloned && local && start.trim() ? 'Link and run it' : 'Link and open'}
        </Button>
      </div>
    </div>
  );
}

/** The app folders right inside `root` (none while `root` is null), for “did you mean…”. */
function useAppsInside(root: string | null): { name: string; path: string; framework?: undefined }[] {
  const [found, setFound] = useState<{ name: string; path: string }[]>([]);
  useEffect(() => {
    setFound([]);
    if (!root) return;
    let live = true;
    apps
      .folders(root)
      .then((l) => live && setFound(l.folders.filter((f) => f.app).map((f) => ({ name: f.name, path: f.path }))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [root]);
  return found;
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-fg-2">{label}</span>
      {children}
      <span className="mt-1 block text-[11.5px] leading-snug text-fg-3">{hint}</span>
    </label>
  );
}
