/**
 * Camera preview with the tracked hand drawn on top, the reach box, and a
 * live gesture legend. Drag it to any corner.
 */
import { animate, motion, useMotionValue } from 'motion/react';
import { Grab, Hand, HandFist, Maximize2, Minimize2, RotateCw, Settings2, ThumbsDown, ThumbsUp, VideoOff, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from '@/components/ui/button';
import { PeaceGlyph, PinchGlyph, PointGlyph } from '@/components/ui/gestures';
import { Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';
import { controller } from '@/core/controller';
import { HandPreview } from '@/components/HandPreview';
import { useSettings, type Corner } from '@/core/settings';
import { set, useStudio, type HandHud } from '@/core/store';
import { cn } from '@/lib/cn';

export const PIP_SIZES = { small: { w: 224, h: 168 }, large: { w: 320, h: 240 } };
export const PIP_MARGIN = 16;
const MARGIN = PIP_MARGIN;
const SIZES = PIP_SIZES;

type LegendKey = 'point' | 'pinch' | 'drag' | 'palm' | 'up' | 'down' | 'peace' | 'fist';
const LEGEND: { key: LegendKey; icon: ReactNode; label: string; does: string }[] = [
  { key: 'point', icon: <PointGlyph />, label: 'Point', does: 'Aim the cursor' },
  { key: 'pinch', icon: <PinchGlyph />, label: 'Pinch', does: 'Select, or deselect (Edit); click (Use). Hold to add.' },
  { key: 'drag', icon: <Grab />, label: 'Pinch + move', does: 'Scroll the app' },
  { key: 'peace', icon: <PeaceGlyph />, label: 'Peace sign', does: 'Start talking; pause to send' },
  { key: 'up', icon: <ThumbsUp />, label: 'Thumb up', does: 'Keep the preview' },
  { key: 'down', icon: <ThumbsDown />, label: 'Thumb down', does: 'Undo the preview' },
  { key: 'palm', icon: <Hand />, label: 'Open palm', does: 'Stop / cancel' },
  { key: 'fist', icon: <HandFist />, label: 'Fist', does: 'Pause the cursor to reposition your hand' },
];

function activeKey(h: HandHud): LegendKey | null {
  if (!h.present) return null;
  if (h.dragging) return 'drag';
  switch (h.pose) {
    case 'point':
      return 'point';
    case 'pinch':
      return 'pinch';
    case 'open':
      return 'palm';
    case 'thumbUp':
      return 'up';
    case 'thumbDown':
      return 'down';
    case 'victory':
      return 'peace';
    case 'fist':
      return 'fist';
    default:
      return null;
  }
}

const STATUS: Record<LegendKey, string> = {
  point: 'Pointing',
  pinch: 'Pinching',
  drag: 'Scrolling',
  palm: 'Hold still to stop',
  up: 'Hold to keep',
  down: 'Hold to undo',
  peace: 'Hold to talk',
  fist: 'Cursor paused',
};

function cornerPos(corner: Corner, area: { w: number; h: number }, size: { w: number; h: number }, legend: number): { x: number; y: number } {
  const h = size.h + legend;
  return {
    x: corner.endsWith('l') ? MARGIN : Math.max(MARGIN, area.w - size.w - MARGIN),
    y: corner.startsWith('t') ? 64 : Math.max(64, area.h - h - MARGIN),
  };
}

export function CameraPip() {
  const cam = useStudio((s) => s.camera);
  const hand = useStudio((s) => s.hand);
  const pip = useSettings((s) => s.camera.pip);
  const corner = useSettings((s) => s.camera.corner);
  const showLegend = useSettings((s) => s.camera.legend);
  const setCamera = useSettings((s) => s.setCamera);
  const root = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const x = useMotionValue(MARGIN);
  const y = useMotionValue(400);
  const size = SIZES[pip];
  const legendH = showLegend ? 70 : 34;
  const visible = cam.status === 'on' || cam.status === 'starting' || (cam.status === 'error' && dismissedError !== cam.error);

  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(([e]) => setArea({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!area.w) return;
    const p = cornerPos(corner, area, size, legendH);
    animate(x, p.x, { type: 'spring', stiffness: 420, damping: 38 });
    animate(y, p.y, { type: 'spring', stiffness: 420, damping: 38 });
  }, [corner, area, size, legendH, x, y]);

  const active = activeKey(hand);
  const nearest = (px: number, py: number): Corner => {
    const left = px + size.w / 2 < area.w / 2;
    const top = py + (size.h + legendH) / 2 < area.h / 2;
    return `${top ? 't' : 'b'}${left ? 'l' : 'r'}` as Corner;
  };

  return (
    <motion.div
      ref={root}
      drag
      dragMomentum={false}
      onDragEnd={() => {
        const c = nearest(x.get(), y.get());
        if (c === corner) {
          const p = cornerPos(c, area, size, legendH);
          animate(x, p.x, { type: 'spring', stiffness: 420, damping: 38 });
          animate(y, p.y, { type: 'spring', stiffness: 420, damping: 38 });
        } else setCamera({ corner: c });
      }}
      style={{ x, y, width: size.w }}
      className={cn('glass absolute left-0 top-0 z-30 overflow-hidden rounded-[14px] transition-[width] duration-200', !visible && 'pointer-events-none invisible')}
      data-hand-ignore
    >
      <div className="group relative bg-black" style={{ height: size.h }}>
        <HandPreview className="absolute inset-0" />
        {cam.status === 'starting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-[12px] text-white/80">
            <Spinner className="size-4" />
            Starting hand tracking…
          </div>
        )}
        {cam.status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#120c0c] p-3 text-center text-[11.5px] leading-snug text-white/80">
            <VideoOff className="size-5 text-bad" />
            {cam.error}
            <div className="flex gap-1.5">
              <button data-hand className="rounded-[6px] bg-white/15 px-2 py-1 text-[11.5px] font-medium text-white hover:bg-white/25" onClick={() => void controller.startCamera()}>
                <RotateCw className="mr-1 inline size-3" />
                Retry
              </button>
              <button data-hand className="rounded-[6px] px-2 py-1 text-[11.5px] text-white/70 hover:text-white" onClick={() => setDismissedError(cam.error)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        {cam.status === 'on' && !hand.present && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-[11.5px] font-medium text-white/85 [text-shadow:0_1px_3px_rgba(0,0,0,.8)]">Raise your hand into the box</div>
        )}
        <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <PipButton label={pip === 'small' ? 'Larger' : 'Smaller'} onClick={() => setCamera({ pip: pip === 'small' ? 'large' : 'small' })}>
            {pip === 'small' ? <Maximize2 /> : <Minimize2 />}
          </PipButton>
          <PipButton label="Hand settings" onClick={() => set({ overlay: 'settings', settingsTab: 'hand' })}>
            <Settings2 />
          </PipButton>
          <PipButton label="Turn off hand control (C)" onClick={() => controller.stopCamera()}>
            <X />
          </PipButton>
        </div>
      </div>
      <div className="flex h-[34px] items-center gap-2 px-2.5 text-[11.5px]">
        <span className={cn('size-1.5 rounded-full', hand.present ? 'bg-human' : 'bg-fg-3/60')} />
        <span className={cn('font-medium', hand.present ? 'text-fg' : 'text-fg-3')}>{active ? STATUS[active] : hand.present ? 'Hand found' : 'No hand'}</span>
        <span className="ml-auto font-mono text-[10.5px] text-fg-3">
          {cam.fps ? `${cam.fps} fps` : ''} {cam.delegate === 'CPU' ? '· CPU' : ''}
        </span>
      </div>
      {showLegend && (
        <div className="flex items-center justify-between border-t border-line px-1.5 py-1">
          {LEGEND.map((g) => (
            <Tip key={g.key} side="top" label={<span><b className="font-medium">{g.label}</b> · {g.does}</span>}>
              <span
                className={cn(
                  'flex size-[24px] items-center justify-center rounded-[6px] text-fg-3 transition-colors [&_svg]:size-[15px]',
                  active === g.key && 'bg-human-soft text-human-fg',
                )}
              >
                {g.icon}
              </span>
            </Tip>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function PipButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tip label={label}>
      <IconButton size="sm" onClick={onClick} aria-label={label} className="size-6 rounded-[6px] bg-black/50 text-white/85 backdrop-blur hover:bg-black/70 hover:text-white [&_svg]:size-[12px]">
        {children}
      </IconButton>
    </Tip>
  );
}
