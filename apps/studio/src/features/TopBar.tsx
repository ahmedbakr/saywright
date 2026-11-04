import { ChevronDown, CircleHelp, Laptop, Mic, MicOff, Monitor, MousePointerClick, PanelRight, RotateCw, Search, Settings2, Smartphone, SquareDashedMousePointer, Tablet } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { IconButton } from '@/components/ui/button';
import { Dot } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/segmented';
import { Tip } from '@/components/ui/tooltip';
import { controller } from '@/core/controller';
import { useSettings, type DevicePreset } from '@/core/settings';
import { set, useStudio, type Mode } from '@/core/store';
import { cn } from '@/lib/cn';
import { compact, shortcut, usd } from '@/lib/format';
import { SessionControl } from './session/SessionControl';
import { AppSwitcher } from './apps/AppSwitcher';
import { BRAND } from '@shared/brand';

export const DEVICES: Record<DevicePreset, { label: string; size: [number, number] | null; icon: ReactNode }> = {
  fill: { label: 'Fit to window', size: null, icon: <Monitor /> },
  desktop: { label: 'Desktop · 1280', size: [1280, 800], icon: <Laptop /> },
  tablet: { label: 'Tablet · 820', size: [820, 1180], icon: <Tablet /> },
  mobile: { label: 'Phone · 390', size: [390, 844], icon: <Smartphone /> },
};

function RecordIcon({ on }: { on: boolean }) {
  return (
    <span className="relative inline-flex size-[13px] items-center justify-center">
      <span className={cn('size-[9px] rounded-full', on ? 'bg-bad' : 'bg-current')} style={on ? { animation: 'rec-pulse 1.4s ease-in-out infinite' } : undefined} />
    </span>
  );
}

/** The modes, named by what they are for (their ids and keys stay edit, use, record). */
export const MODE_LABEL: Record<Mode, string> = { edit: 'Edit', use: 'Use', record: 'Write test' };

/**
 * The studio's top bar. The mode switcher sits in the middle while there is
 * room and moves aside rather than overlapping anything; below 1180 px wide
 * labels collapse to icons (names stay for screen readers and in tooltips).
 */
export function TopBar() {
  const mode = useStudio((s) => s.mode);
  const status = useStudio((s) => s.status);
  const panelOpen = useSettings((s) => s.ui.panelOpen);
  const setUi = useSettings((s) => s.setUi);

  return (
    <header className="relative z-20 flex h-[46px] shrink-0 items-center gap-2 border-b border-line bg-panel pl-3 pr-2">
      <h1 className="sr-only">{status?.app ? `${BRAND.name} · ${status.app.name}` : BRAND.name}</h1>
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-2.5">
        <Logo className="size-[22px] shrink-0" />
        <span className="hidden text-[13px] font-semibold tracking-[-0.01em] text-fg min-[1180px]:inline">{BRAND.name}</span>
        <span className="mx-1 hidden h-4 w-px bg-line-strong min-[1180px]:block" />
        <div className="flex min-w-0 items-center gap-0.5">
          <AppSwitcher />
          {status?.app && (
            <Tip label="Reload the app">
              <IconButton size="sm" onClick={() => controller.reloadApp()} aria-label="Reload the app">
                <RotateCw />
              </IconButton>
            </Tip>
          )}
        </div>
      </div>

      <div className="shrink-0" data-mode-switcher>
        <Segmented<Mode>
          value={mode}
          onChange={(m) => controller.setMode(m)}
          collapse
          options={[
            { value: 'edit', label: MODE_LABEL.edit, icon: <SquareDashedMousePointer />, tip: 'Edit: point at things and change them', kbd: 'E' },
            { value: 'use', label: MODE_LABEL.use, icon: <MousePointerClick />, tip: 'Use: click through your app as usual', kbd: 'U' },
            { value: 'record', label: MODE_LABEL.record, icon: <RecordIcon on={mode === 'record'} />, tip: 'Write test: use your app, say what it should show, get a Playwright test', kbd: 'R' },
          ]}
        />
      </div>

      <div className="flex flex-1 basis-0 items-center justify-end gap-1">
        <SessionControl />
        <span className="mx-1 h-4 w-px bg-line-strong" />
        <DeviceMenu />
        <span className="mx-1 h-4 w-px bg-line-strong" />
        <MicChip />
        <AiChip />
        <span className="mx-1 h-4 w-px bg-line-strong" />
        <Tip label="Command palette: every action, by name" kbd={shortcut('mod+k')}>
          <IconButton onClick={() => set({ overlay: 'palette' })} aria-label="Command palette" data-tour="palette">
            <Search />
          </IconButton>
        </Tip>
        <Tip label="Phrases and shortcuts" kbd="?">
          <IconButton onClick={() => set({ overlay: 'help' })} aria-label="Help" data-tour="help">
            <CircleHelp />
          </IconButton>
        </Tip>
        <Tip label="Settings">
          <IconButton onClick={() => set({ overlay: 'settings', settingsTab: 'general' })} aria-label="Settings">
            <Settings2 />
          </IconButton>
        </Tip>
        <Tip label={panelOpen ? 'Hide panel' : 'Show panel'} kbd="\">
          <IconButton active={panelOpen} onClick={() => setUi({ panelOpen: !panelOpen })} aria-label="Toggle panel">
            <PanelRight />
          </IconButton>
        </Tip>
      </div>
    </header>
  );
}

function Chip({ children, onClick, label, tone, ...rest }: { children: ReactNode; onClick: () => void; label: ReactNode; tone?: 'warn' | 'bad' | 'human'; 'data-tour'?: string }) {
  return (
    <Tip label={label}>
      <button
        {...rest}
        onClick={onClick}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[12px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-[14px]',
          tone === 'warn' && 'text-warn hover:text-warn',
          tone === 'bad' && 'text-bad hover:text-bad',
          tone === 'human' && 'text-human-fg hover:text-human-fg',
        )}
      >
        {children}
      </button>
    </Tip>
  );
}

function MicChip() {
  const v = useStudio((s) => s.voice);
  if (!v.supported)
    return (
      <Chip onClick={() => set({ overlay: 'settings', settingsTab: 'voice' })} label="Voice isn’t available with these settings in this browser" tone="warn">
        <MicOff /> Voice
      </Chip>
    );
  const on = v.state === 'starting' || v.state === 'listening';
  return (
    <Chip onClick={() => controller.toggleTalk()} label={on ? 'Listening… (Space or pause to send)' : 'Talk: hold Space, or tap it for hands-free'} tone={on ? 'human' : undefined}>
      {on ? <Dot tone="human" pulse /> : <Mic />} Voice
    </Chip>
  );
}

/**
 * Who answers requests and what today cost, always in view: the AI and today's spend (plan use for a plan, free for
 * a model on this computer), or that quick edits are free without one. Opens Settings → AI, or the usage once there
 * is some; near the budget it warns, at it it stops.
 */
export function AiChip() {
  const ai = useStudio((s) => s.status?.ai);
  if (!ai) return null;
  if (!ai.ready)
    return (
      <Chip
        onClick={() => set({ overlay: 'settings', settingsTab: 'ai' })}
        label="No AI connected. Quick edits (size, variant, text, move, remove) are free and work offline. Connect your Claude, ChatGPT or Gemini plan, an API key, or a model on this computer for the rest."
        tone="warn"
        data-tour="ai"
      >
        <Dot tone="warn" /> No AI <span className="hidden text-fg-3 xl:inline">· quick edits are free</span>
      </Chip>
    );
  const u = ai.usage;
  const name = ai.source === 'fake' ? 'AI (test)' : shortAiName(ai.who);
  const local = ai.who?.connection === 'ollama' || ai.who?.connection === 'lmstudio';
  const spend = ai.who?.plan ? (u.planUsd >= 0.005 ? `${usd(u.planUsd)} of plan use` : 'no extra bill') : local ? 'free' : `${usd(u.usd)} today`;
  const today = u.calls ? ` · Today: ${u.usd >= 0.005 ? `${usd(u.usd)}, ` : ''}${compact(u.tokens)} tokens in ${u.calls} call${u.calls === 1 ? '' : 's'}${u.planUsd >= 0.01 ? ` (plan use worth ${usd(u.planUsd)} at API prices; no extra bill)` : ''}` : ' · Nothing used today';
  return (
    <Chip
      onClick={() => set({ overlay: 'settings', settingsTab: u.calls || u.level !== 'ok' ? 'usage' : 'ai' })}
      label={`${ai.who ? `${ai.who.label} · ${ai.who.model}` : 'AI'} · ${ai.effort} effort${today}${u.message ? ` · ${u.message}` : ''}`}
      tone={u.level === 'over' ? 'bad' : u.level === 'warn' ? 'warn' : undefined}
      data-tour="ai"
    >
      <Dot tone={u.level === 'ok' ? 'ai' : u.level === 'warn' ? 'warn' : 'bad'} /> {name}
      <span data-usage-today className="tabular-nums text-fg-3">
        · {spend}
      </span>
    </Chip>
  );
}

/** "Opus 5.5", "Claude plan", "GPT-6.1 Sol". */
function shortAiName(who: { connection: string; label: string; model: string; plan: boolean } | null): string {
  if (!who) return 'AI';
  if (who.plan) return who.connection === 'claude-code' ? 'Claude plan' : who.connection === 'codex' ? 'ChatGPT plan' : 'Gemini';
  return who.model.replace(/^Claude /, '');
}

function DeviceMenu() {
  const device = useSettings((s) => s.ui.device);
  const setUi = useSettings((s) => s.setUi);
  const d = DEVICES[device];
  return (
    <DropdownMenu.Root>
      <Tip label="Viewport size">
        <DropdownMenu.Trigger asChild>
          <button className="inline-flex h-7 items-center gap-1 rounded-[7px] px-2 text-fg-2 hover:bg-hover hover:text-fg [&_svg]:size-[14px]" aria-label="Viewport size">
            {d.icon}
            <ChevronDown className="!size-3 text-fg-3" />
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-[80] min-w-[200px] rounded-[10px] bg-raised p-1 shadow-pop">
          <DropdownMenu.RadioGroup value={device} onValueChange={(v) => setUi({ device: v as DevicePreset })}>
            {(Object.keys(DEVICES) as DevicePreset[]).map((k) => (
              <DropdownMenu.RadioItem
                key={k}
                value={k}
                className="flex cursor-default items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-[12.5px] text-fg outline-none data-[highlighted]:bg-hover data-[state=checked]:text-human-fg [&_svg]:size-[14px] [&_svg]:text-fg-3"
              >
                {DEVICES[k].icon}
                {DEVICES[k].label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
