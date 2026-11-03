/**
 * The open app in the top bar: its name and the address shown, and a menu to
 * switch address (local, staging, production), switch app, link another or
 * see them all.
 */
import { Check, ChevronDown, Code2, Globe, LayoutGrid, LogOut, Plus } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import { Dot } from '@/components/ui/misc';
import { apps, useApps } from '@/core/apps';
import { useStudio } from '@/core/store';
import { cn } from '@/lib/cn';
import { shortUrl } from '@/lib/format';
import { AppIcon } from './Launcher';

export function AppSwitcher() {
  const status = useStudio((s) => s.status);
  const connected = useStudio((s) => s.app.connected);
  const frameUrl = useStudio((s) => s.app.url);
  const list = useApps((s) => s.apps);
  const current = status?.app;
  const others = list.filter((a) => a.id !== current?.id).slice(0, 6);
  // In the proxy, the frame's address is the proxy's: show the app's own.
  const shown = current ? current.env.url.replace(/\/$/, '') + (frameUrl ? new URL(frameUrl).pathname.replace(/^\/$/, '') : '') : '';
  return (
    <DropdownMenu.Root onOpenChange={(o) => o && void apps.refresh()}>
      <DropdownMenu.Trigger asChild>
        <button data-hand className="flex min-w-0 items-center gap-1.5 rounded-[8px] py-1 pl-1.5 pr-1 text-start hover:bg-hover" data-app-switcher>
          <Dot tone={connected ? 'ok' : 'off'} />
          <span className="truncate text-[13px] font-medium text-fg">{current?.name ?? (status ? 'No app open' : 'Connecting…')}</span>
          {current && current.envs.length > 1 && <span className="shrink-0 rounded-[5px] bg-active px-1.5 text-[10.5px] font-medium text-fg-2">{current.env.label}</span>}
          <span className="hidden max-w-[220px] truncate font-mono text-[11.5px] text-fg-3 md:inline">{shortUrl(shown)}</span>
          <ChevronDown className="size-3.5 shrink-0 text-fg-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="z-[60] w-[300px] rounded-[10px] bg-raised p-1 shadow-pop">
          {current && (
            <>
              <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-fg-3">{current.name}</div>
              {current.envs.map((e) => (
                <Item key={e.id} icon={e.kind === 'local' ? <Code2 /> : <Globe />} onSelect={() => void apps.open(current.id, e.id)} checked={e.id === current.env.id}>
                  <span className="w-[72px] shrink-0">{e.label}</span>
                  <span className="truncate font-mono text-[11px] text-fg-3">{shortUrl(e.url)}</span>
                </Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
            </>
          )}
          {others.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-fg-3">Switch to</div>
              {others.map((a) => (
                <Item key={a.id} icon={<AppIcon app={a} className="size-[18px] rounded-[5px] p-0 text-[9px]" />} onSelect={() => void apps.open(a.id)}>
                  <span className="truncate">{a.name}</span>
                </Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
            </>
          )}
          <Item icon={<LayoutGrid />} onSelect={() => apps.show()}>
            All apps
          </Item>
          <Item icon={<Plus />} onSelect={() => apps.show('folder')}>
            Link an app…
          </Item>
          {current && (
            <Item icon={<LogOut />} onSelect={() => void apps.close()}>
              Close {current.name}
            </Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Item({ icon, children, onSelect, checked }: { icon: ReactNode; children: ReactNode; onSelect: () => void; checked?: boolean }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn('flex h-8 cursor-default items-center gap-2 rounded-[7px] px-2 text-[12.5px] text-fg outline-none data-[highlighted]:bg-hover [&>svg]:size-[14px] [&>svg]:shrink-0 [&>svg]:text-fg-3')}
    >
      {icon}
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {checked && <Check className="size-3.5 text-human" />}
    </DropdownMenu.Item>
  );
}
