/**
 * Boxes drawn over the live app, in app coordinates: what you point at (amber,
 * thin; red in Write test mode, where a check you say or type attaches to it),
 * what you selected (amber; numbered when several are), what the AI changed
 * (cyan), and what "this"/"that" bound to while you talk. Pointing with a hand,
 * a hint under the highlight says what a pinch will do. While a session is
 * replayed, only the replay's target is boxed (cyan).
 */
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDownToLine, ArrowUpToLine, Code2, X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Tip } from '@/components/ui/tooltip';
import { controller } from '@/core/controller';
import { pinchMeaning, selectedOf } from '@/core/selection';
import { useStudio } from '@/core/store';
import { cn } from '@/lib/cn';
import { fileName } from '@/lib/format';
import type { ElementInfo, Rect } from '@saywright/vite/protocol';

const SPRING = { type: 'spring', stiffness: 700, damping: 48, mass: 0.6 } as const;

function srcShort(src: string | null): string | null {
  if (!src) return null;
  const m = /^(.*):(\d+):\d+$/.exec(src);
  return m ? `${fileName(m[1])}:${m[2]}` : src;
}

/**
 * Labels float above the box (inside it when there is no room above), on the side with room to spare.
 * Only their buttons take the pointer: the label itself lets clicks, and a pointing hand, through to the app.
 */
function Tag({ rect, scale, children, tone, frameW }: { rect: Rect; scale: number; children: ReactNode; tone: 'human' | 'ai' | 'soft'; frameW: number }) {
  const above = rect.y > 30 / scale;
  const right = rect.x + rect.w / 2 > frameW * 0.6;
  return (
    <div
      className={cn('pointer-events-none absolute flex', right ? 'right-0' : 'left-0')}
      style={{
        top: above ? undefined : 0,
        bottom: above ? '100%' : undefined,
        transform: `scale(${1 / scale})`,
        transformOrigin: `${above ? 'bottom' : 'top'} ${right ? 'right' : 'left'}`,
        paddingBottom: above ? 4 : 0,
        paddingTop: above ? 0 : 4,
        paddingLeft: above || right ? 0 : 4,
        paddingRight: !above && right ? 4 : 0,
      }}
    >
      <div
        className={cn(
          'flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-[6px] px-1.5 text-[11.5px] font-medium shadow-[0_2px_8px_rgba(0,0,0,.25)]',
          tone === 'human' && 'bg-human text-[#1b1203]',
          tone === 'ai' && 'bg-ai text-[#021a20]',
          tone === 'soft' && 'bg-[#16171c]/90 text-white backdrop-blur',
        )}
      >
        {children}
      </div>
    </div>
  );
}

function HoverBox({ el, scale, snapped, frameW, frameH, hint, record }: { el: ElementInfo; scale: number; snapped: boolean; frameW: number; frameH: number; hint: { tap: string; hold: string | null } | null; record: boolean }) {
  const last = useRef<number | null>(null);
  // Glide between elements, but follow the same element instantly (scrolling).
  const glide = last.current !== null && last.current !== el.id;
  last.current = el.id;
  const r = el.rect;
  return (
    <motion.div
      className="pointer-events-none absolute rounded-[4px]"
      initial={false}
      animate={{ left: r.x, top: r.y, width: r.w, height: r.h, opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={glide ? SPRING : { duration: 0 }}
      style={{ boxShadow: record ? `0 0 0 ${1.5 / scale}px var(--bad), inset 0 0 0 9999px rgba(255,99,105,.07)` : `0 0 0 ${1.5 / scale}px var(--human), inset 0 0 0 9999px rgba(255,178,36,.07)` }}
      data-hover-box={record ? 'record' : 'edit'}
    >
      <Tag rect={r} scale={scale} tone="soft" frameW={frameW}>
        <span className={record ? 'text-[#ff9a9e]' : 'text-[#ffc35a]'}>{el.name}</span>
        {el.text && el.name !== el.text && <span className="max-w-[180px] truncate text-white/70">{el.text}</span>}
        {snapped && <span className="text-white/45">· snapped</span>}
      </Tag>
      {hint && <PinchHint rect={r} scale={scale} frameH={frameH} {...hint} />}
    </motion.div>
  );
}

/** Under the highlight: what a pinch (and holding it) will do, so a pinch never surprises. */
function PinchHint({ rect, scale, frameH, tap, hold }: { rect: Rect; scale: number; frameH: number; tap: string; hold: string | null }) {
  const below = rect.y + rect.h + 30 / scale < frameH;
  return (
    <div
      className="pointer-events-none absolute left-1/2 flex"
      style={{
        top: below ? '100%' : undefined,
        bottom: below ? undefined : 0,
        transform: `translateX(-50%) scale(${1 / scale})`,
        transformOrigin: below ? 'top center' : 'bottom center',
        paddingTop: below ? 5 : 0,
        paddingBottom: below ? 0 : 5,
      }}
      data-pinch-hint
    >
      <div className="flex h-[21px] items-center gap-1.5 whitespace-nowrap rounded-full bg-[#16171c]/90 px-2.5 text-[11px] text-white/75 shadow-[0_2px_8px_rgba(0,0,0,.25)] backdrop-blur">
        <span>
          <span className="font-semibold text-[#ffc35a]">Pinch</span> {tap}
        </span>
        {hold && (
          <>
            <span className="text-white/30">·</span>
            <span>
              <span className="font-semibold text-[#ffc35a]">Hold</span> {hold}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

const TAP_WORDS = { select: 'to select', only: 'to select only this', deselect: 'to deselect', clear: 'to clear', none: '' } as const;
const HOLD_WORDS = { add: 'to add', remove: 'to take out', none: null } as const;

function SelectionBox({ el, scale, frameW, frameH, hint, number }: { el: ElementInfo; scale: number; frameW: number; frameH: number; hint: { tap: string; hold: string | null } | null; number: number | null }) {
  const r = el.rect;
  // Apps without the Vite plugin report a place in the bundle: once the Inspector has traced it, show the source (a guess says so).
  const traced = useStudio((s) => (s.inspect && s.selection?.id === el.id ? `${s.inspect.guessed ? 'likely ' : ''}${fileName(s.inspect.file)}:${s.inspect.line}` : null));
  return (
    <div
      className="pointer-events-none absolute rounded-[4px]"
      style={{ left: r.x, top: r.y, width: r.w, height: r.h, boxShadow: `0 0 0 ${2 / scale}px var(--human), 0 0 0 ${6 / scale}px var(--human-soft)` }}
    >
      {[
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([x, y]) => (
        <span
          key={`${x}${y}`}
          className="absolute rounded-[2px] bg-panel"
          style={{
            width: 7 / scale,
            height: 7 / scale,
            left: `calc(${x * 100}% - ${3.5 / scale}px)`,
            top: `calc(${y * 100}% - ${3.5 / scale}px)`,
            boxShadow: `0 0 0 ${1.5 / scale}px var(--human)`,
          }}
        />
      ))}
      <Tag rect={r} scale={scale} tone="human" frameW={frameW}>
        {number != null && <span className="flex size-4 items-center justify-center rounded-full bg-[#1b1203] font-mono text-[10px] text-human">{number}</span>}
        <span>{el.name}</span>
        {(traced || el.src) && <span className="font-mono text-[10.5px] font-normal opacity-70">{traced ?? srcShort(el.src)}</span>}
        <span className="h-3 w-px bg-black/20" />
        <ToolButton label="Select what contains it" kbd="↑" onClick={() => void controller.step('parent')}>
          <ArrowUpToLine />
        </ToolButton>
        <ToolButton label="Select inside it" kbd="↓" onClick={() => void controller.step('child')}>
          <ArrowDownToLine />
        </ToolButton>
        <ToolButton label="Open in editor" kbd="O" onClick={() => void controller.openInEditor(el)}>
          <Code2 />
        </ToolButton>
        <ToolButton label="Deselect" onClick={() => controller.deselect(el.id)}>
          <X />
        </ToolButton>
      </Tag>
      {hint && <PinchHint rect={r} scale={scale} frameH={frameH} {...hint} />}
    </div>
  );
}

/** The element the replay is about to click, fill or press, and which step that is. */
function ReplayTarget({ el, step, total, scale, frameW }: { el: ElementInfo | null; step: number; total: number; scale: number; frameW: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <AnimatePresence>
        {el && (
          <motion.div
            key={`replay-${step}`}
            className="absolute rounded-[4px]"
            initial={{ opacity: 0, scale: 1.08 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.2, ease: [0.2, 0.9, 0.25, 1] }}
            style={{ left: el.rect.x, top: el.rect.y, width: el.rect.w, height: el.rect.h, boxShadow: `0 0 0 ${2 / scale}px var(--ai), 0 0 0 ${6 / scale}px rgba(60,200,232,.2), inset 0 0 0 9999px rgba(60,200,232,.08)` }}
            data-replay-target={step}
          >
            <Tag rect={el.rect} scale={scale} tone="ai" frameW={frameW}>
              Step {step} of {total}
            </Tag>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToolButton({ label, kbd, onClick, children }: { label: string; kbd?: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tip label={label} kbd={kbd} side="top">
      <button
        data-hand
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        // 18 px, spaced so each has the 24 px around it a target needs, without a taller tag over the app.
        className="pointer-events-auto mx-[3px] inline-flex size-[18px] items-center justify-center rounded-[4px] hover:bg-black/15 [&_svg]:size-[12px]"
        aria-label={label}
      >
        {children}
      </button>
    </Tip>
  );
}

export function Overlays({ scale, width, height }: { scale: number; width: number; height: number }) {
  const mode = useStudio((s) => s.mode);
  const hover = useStudio((s) => s.hover);
  const snapped = useStudio((s) => s.snapped);
  const selection = useStudio((s) => s.selection);
  const pins = useStudio((s) => s.pins);
  const pointer = useStudio((s) => s.pointer);
  const listening = useStudio((s) => s.voice.state === 'listening');
  const bindings = useStudio((s) => s.voice.bindings);
  const previewTargets = useStudio((s) => s.previewTargets);
  const changes = useStudio((s) => s.changes);
  const replay = useStudio((s) => s.replay);
  const handPinching = useStudio((s) => s.hand.pose === 'pinch');

  if (replay) return <ReplayTarget el={replay.target} step={replay.step} total={replay.total} scale={scale} frameW={width} />;

  const bound = listening && bindings.some((b) => b.el?.id === hover?.id);
  // Write test mode boxes it too: a check you say or type attaches to what is under the pointer.
  const showHover = !!hover && (mode === 'edit' || mode === 'record' || pointer === 'hand' || listening) && hover.id !== selection?.id && !bound;
  // What a pinch on the highlight would do, for a hand in Edit mode (hidden while the fingers are together).
  const meaning = mode === 'edit' && pointer === 'hand' && !listening && !handPinching && hover ? pinchMeaning(hover, selectedOf({ selection, pins })) : null;
  const hint = meaning && meaning.tap !== 'none' ? { tap: TAP_WORDS[meaning.tap], hold: HOLD_WORDS[meaning.hold] } : null;
  const pending = new Set(changes.filter((c) => c.status === 'preview').map((c) => c.id));
  const aiBoxes = previewTargets.filter((p) => pending.has(p.changeId));
  const seen = new Set<number>();

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {aiBoxes
        .filter((p) => (seen.has(p.el.id) ? false : (seen.add(p.el.id), true)))
        .map((p) => (
          <div
            key={`ai-${p.el.id}`}
            className="absolute rounded-[4px]"
            style={{ left: p.el.rect.x, top: p.el.rect.y, width: p.el.rect.w, height: p.el.rect.h, boxShadow: `0 0 0 ${1.5 / scale}px var(--ai), inset 0 0 0 9999px rgba(60,200,232,.06)` }}
          >
            {p.el.id !== selection?.id && (
              <Tag rect={p.el.rect} scale={scale} tone="ai" frameW={width}>
                Preview
              </Tag>
            )}
          </div>
        ))}

      {pins
        .map((p, i) => [p, i] as const)
        .filter(([p]) => p.id !== selection?.id)
        .map(([p, i]) => (
          <div
            key={`pin-${p.id}`}
            className="absolute rounded-[4px]"
            style={{ left: p.rect.x, top: p.rect.y, width: p.rect.w, height: p.rect.h, boxShadow: `0 0 0 ${1.5 / scale}px var(--human), 0 0 0 ${5 / scale}px var(--human-soft)` }}
            data-picked={i + 1}
          >
            <span
              className="absolute flex items-center justify-center rounded-full bg-human font-mono text-[11px] font-semibold text-[#1b1203] shadow-[0_2px_6px_rgba(0,0,0,.3)]"
              style={{ width: 18, height: 18, right: -9 / scale, top: -9 / scale, transform: `scale(${1 / scale})` }}
            >
              {i + 1}
            </span>
          </div>
        ))}

      {selection && (
        <SelectionBox
          el={selection}
          scale={scale}
          frameW={width}
          frameH={height}
          number={pins.length ? pins.findIndex((p) => p.id === selection.id) + 1 || null : null}
          hint={hover?.id === selection.id ? hint : null}
        />
      )}

      <AnimatePresence>
        {showHover && hover && <HoverBox key="hover" el={hover} scale={scale} snapped={snapped && pointer === 'hand'} frameW={width} frameH={height} hint={hint} record={mode === 'record'} />}
      </AnimatePresence>

      <AnimatePresence>
        {listening &&
          bindings
            .filter((b) => b.el)
            .map((b) => (
              <motion.div
                key={`bind-${b.index}`}
                className="absolute rounded-[4px]"
                initial={{ opacity: 0, scale: 1.04 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                style={{ left: b.el!.rect.x, top: b.el!.rect.y, width: b.el!.rect.w, height: b.el!.rect.h, boxShadow: `0 0 0 ${2 / scale}px var(--human), inset 0 0 0 9999px rgba(255,178,36,.12)` }}
              >
                <Tag rect={b.el!.rect} scale={scale} tone="human" frameW={width}>
                  “{b.word}”
                </Tag>
              </motion.div>
            ))}
      </AnimatePresence>
    </div>
  );
}
