import { ContextMenu } from 'radix-ui';
import { AppWindow, ArrowUpToLine, Code2, Copy, MessageSquareText, PlugZap, ScanLine, SquarePlus } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { StatusResponse } from '@shared/api';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { apps } from '@/core/apps';
import { cn } from '@/lib/cn';
import { shortcut } from '@/lib/format';
import { controller } from '@/core/controller';
import { selectedOf } from '@/core/selection';
import { useSettings } from '@/core/settings';
import { get, set, useStudio } from '@/core/store';
import type { ElementInfo } from '@saywright/vite/protocol';
import { Dock } from './Dock';
import { Island } from './Island';
import { Overlays } from './Overlays';
import { DEVICES } from './TopBar';

const PAD_X = 28;
const PAD_TOP = 64;
const PAD_BOTTOM = 104;

export function Stage() {
  const status = useStudio((s) => s.status);
  const statusError = useStudio((s) => s.statusError);
  const connected = useStudio((s) => s.app.connected);
  const outdated = useStudio((s) => s.app.outdated);
  const reloadKey = useStudio((s) => s.app.reloadKey);
  const mode = useStudio((s) => s.mode);
  const replaying = useStudio((s) => !!s.replay);
  const device = useSettings((s) => s.ui.device);
  const areaRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [slow, setSlow] = useState(false);
  // The app itself, or the studio's proxy in front of it (any framework, a deployed site).
  const url = status?.target.frameUrl || undefined;

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setArea({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const availW = Math.max(200, area.w - PAD_X * 2);
  const availH = Math.max(200, area.h - PAD_TOP - PAD_BOTTOM);
  const size = DEVICES[device].size;
  const scale = size ? Math.min(1, availW / size[0], availH / size[1]) : 1;
  const w = size ? size[0] : availW;
  const h = size ? size[1] : availH;

  const measured = area.w > 0;
  useEffect(() => controller.setScale(scale), [scale]);
  // The frame only exists once the stage has been measured, so attach when it appears.
  useEffect(() => {
    if (!measured) return;
    controller.attachFrame(frameRef.current, url);
    return () => controller.attachFrame(null);
  }, [url, reloadKey, measured]);
  // Only cover the app if it stays disconnected for a moment (hot reloads reconnect within ms).
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    setSlow(false);
    if (connected) {
      setWaiting(false);
      return;
    }
    const show = setTimeout(() => setWaiting(true), 350);
    const t = setTimeout(() => setSlow(true), 6000);
    return () => {
      clearTimeout(show);
      clearTimeout(t);
    };
  }, [connected, url, reloadKey]);

  return (
    <main ref={areaRef} className="canvas-grid relative min-w-0 flex-1 overflow-hidden" data-stage>
      {area.w > 0 && (
        <div className="absolute left-1/2 -translate-x-1/2" style={{ top: PAD_TOP, width: w * scale, height: h * scale }}>
          <div
            className="relative overflow-hidden rounded-[10px] bg-white shadow-frame"
            style={{ width: w, height: h, transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: '0 0' }}
            data-tour="frame"
          >
            {url && (
              <iframe
                key={reloadKey}
                ref={frameRef}
                src={url}
                title="Your app"
                className="absolute inset-0 size-full border-0 bg-white"
                onLoad={() => controller.frameLoaded()}
              />
            )}
            <EditLayer active={mode === 'edit' && !replaying} />
            <Overlays scale={scale} width={w} />
            {/* A replay is playing: it alone acts on the app (Stop hands it back). */}
            {replaying && <div className="absolute inset-0 z-[15] cursor-progress" data-replay-shield />}
            {/* A plain fade: it must never be left behind blocking the pointer. */}
            <div
              className={cn(
                'absolute inset-0 z-20 flex items-center justify-center bg-canvas/80 backdrop-blur-sm transition-opacity duration-300',
                waiting ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
              aria-hidden={!waiting}
            >
              {waiting && <Connecting app={status?.app ?? null} loaded={!!status} url={url} slow={slow} error={statusError} outdated={outdated} />}
            </div>
          </div>
        </div>
      )}
      <Island />
      <Dock />
    </main>
  );
}

/**
 * What covers the stage until the app answers: no app open, still connecting (and why it may be slow), no studio
 * server, or an app whose plugin and this studio can't work together.
 */
function Connecting({ app, loaded, url, slow, error, outdated }: { app: StatusResponse['app']; loaded: boolean; url?: string; slow: boolean; error: string | null; outdated?: 'plugin' | 'studio' }) {
  if (outdated)
    return (
      <div className="max-w-[380px] text-center" data-outdated={outdated}>
        <PlugZap className="mx-auto mb-3 size-6 text-warn" />
        <div className="text-[13px] font-medium text-fg">{outdated === 'plugin' ? 'This app’s Saywright plugin needs an update' : 'This studio is older than the app’s Saywright plugin'}</div>
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
          {outdated === 'plugin' ? (
            <>
              In the app’s folder, run <span className="font-mono text-fg-2">npm i -D @saywright/vite@latest</span>, then restart its dev server.
            </>
          ) : (
            <>
              Update Saywright: stop it and start it again with <span className="font-mono text-fg-2">npx @saywright/studio@latest</span>.
            </>
          )}
        </div>
      </div>
    );
  if (error)
    return (
      <div className="max-w-[340px] text-center">
        <PlugZap className="mx-auto mb-3 size-6 text-warn" />
        <div className="text-[13px] font-medium text-fg">The studio server isn’t responding</div>
        <div className="mt-1 text-[12.5px] text-fg-3">Check that Saywright is still running in the terminal you started it from.</div>
      </div>
    );
  if (loaded && !app)
    return (
      <div className="max-w-[360px] text-center" data-no-app>
        <AppWindow className="mx-auto mb-3 size-6 text-fg-3" />
        <div className="text-[13px] font-medium text-fg">No app open</div>
        <div className="mt-1 text-[12.5px] text-fg-3">Open one of your apps, or link a new one.</div>
        <div className="mt-3 flex justify-center gap-2">
          <Button variant="primary" onClick={() => apps.show()}>
            Open an app
          </Button>
          <Button onClick={() => void apps.sample()}>Try the sample shop</Button>
        </div>
      </div>
    );
  const address = app?.env.url || url;
  return (
    <div className="max-w-[360px] text-center">
      <Spinner className="mx-auto mb-3 size-5 text-fg-3" />
      <div className="text-[13px] font-medium text-fg">{app ? `Connecting to ${app.name}…` : 'Connecting to your app…'}</div>
      {slow && address && (
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
          Still waiting for <span className="font-mono text-fg-2">{address}</span>. Check that it is running
          {app?.env.connection === 'plugin' ? (
            <>
              {' '}
              and that its Vite config includes the <span className="font-mono text-fg-2">saywright()</span> plugin
            </>
          ) : null}
          .
        </div>
      )}
    </div>
  );
}

/** In Edit mode the stage captures the mouse: hovering highlights, clicking selects, right-click offers actions. */
function EditLayer({ active }: { active: boolean }) {
  const [menuFor, setMenuFor] = useState<ElementInfo | null>(null);
  return (
    <ContextMenu.Root onOpenChange={(open) => !open && setMenuFor(null)}>
      <ContextMenu.Trigger asChild disabled={!active}>
        <div
          className={active ? 'absolute inset-0' : 'pointer-events-none absolute inset-0'}
          onPointerMove={(e) => controller.mouseMove(e.clientX, e.clientY, e.altKey)}
          onPointerLeave={() => controller.mouseLeave()}
          onClick={(e) => void controller.mouseClick(e.clientX, e.clientY, e.shiftKey, e.altKey, e.detail)}
          onWheel={(e) => controller.wheel(e.deltaX, e.deltaY)}
          onContextMenu={() => setMenuFor(get().hover)}
        />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-[80] min-w-[220px] rounded-[10px] bg-raised p-1 shadow-pop">
          {menuFor ? (
            <>
              <div className="truncate px-2 pb-1.5 pt-1 text-[11.5px] text-fg-3">{menuFor.label}</div>
              <MenuItem icon={<ScanLine />} onSelect={() => controller.select(menuFor)}>
                Select
              </MenuItem>
              <MenuItem icon={<SquarePlus />} onSelect={() => controller.toggleSelected(menuFor)} hint={shortcut('shift+Click')}>
                {selectedOf(get()).some((p) => p.id === menuFor.id) ? 'Take out of the selection' : 'Add to the selection'}
              </MenuItem>
              <MenuItem
                icon={<ArrowUpToLine />}
                onSelect={async () => {
                  const p = await controller.bridge.step(menuFor.id, 'parent');
                  if (p) controller.select(p);
                }}
              >
                Select what contains it
              </MenuItem>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <MenuItem
                icon={<MessageSquareText />}
                onSelect={() => {
                  controller.select(menuFor);
                  set({ focusInput: get().focusInput + 1 });
                }}
              >
                Ask about this…
              </MenuItem>
              <MenuItem icon={<Code2 />} onSelect={() => void controller.openInEditor(menuFor)} hint="O">
                Open in editor
              </MenuItem>
              <MenuItem icon={<Copy />} onSelect={() => void controller.copyLocator(menuFor)}>
                Copy Playwright locator
              </MenuItem>
            </>
          ) : (
            <div className="px-2 py-1.5 text-[12px] text-fg-3">Nothing under the pointer</div>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function MenuItem({ icon, children, onSelect, hint }: { icon: ReactNode; children: ReactNode; onSelect: () => void; hint?: string }) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-[12.5px] text-fg outline-none data-[highlighted]:bg-hover [&_svg]:size-[14px] [&_svg]:text-fg-3"
    >
      {icon}
      <span className="flex-1">{children}</span>
      {hint && <span className="font-mono text-[11px] text-fg-3">{hint}</span>}
    </ContextMenu.Item>
  );
}
