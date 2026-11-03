/**
 * The command dock: talk (hold or tap), or type. Shows what your words will
 * apply to (what is selected, numbered when several are) and quick suggestions for the selected component.
 * Right after a typed request focus is still here, so an empty bar takes the preview's keys: Enter keeps, Ctrl Z undoes.
 */
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Mic, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { Tip } from '@/components/ui/tooltip';
import { controller } from '@/core/controller';
import { keepUndoHint, previewKey } from '@/core/keys';
import { useSettings } from '@/core/settings';
import { PIP_MARGIN, PIP_SIZES } from './CameraPip';
import { useStudio, type InspectResult, type Mode } from '@/core/store';
import { cn } from '@/lib/cn';
import { isMac } from '@/lib/format';

interface Suggestion {
  label: string;
  run: () => void;
}

const VALUE_LABEL: Record<string, string> = { sm: 'small', md: 'medium', lg: 'large', xl: 'extra large' };

function suggestionsFor(mode: Mode, inspect: InspectResult | null, hasSelection: boolean, rec: { expectations: number; spec: boolean; failed: boolean }, fill: (t: string) => void): Suggestion[] {
  const say = (text: string) => () => void controller.handleUtterance(text, null, 'typed');
  if (mode === 'record') {
    const out: Suggestion[] = [];
    if (rec.failed) out.push({ label: 'Fix it', run: () => void controller.fix() });
    if (rec.expectations) out.push({ label: rec.spec ? 'Run test' : 'Generate test', run: () => void (rec.spec ? controller.runTest() : controller.generateTest()) });
    if (hasSelection) out.push({ label: 'This should show…', run: () => fill('this should show ') });
    return out;
  }
  if (!hasSelection) return [];
  const out: Suggestion[] = [];
  if (inspect?.designSystem) {
    const ordered = inspect.props.find((p) => p.options && ['size', 'padding', 'columns', 'gap'].includes(p.name));
    if (ordered?.options) {
      const i = ordered.options.indexOf(ordered.value);
      if (i < ordered.options.length - 1) out.push({ label: ordered.name === 'padding' || ordered.name === 'gap' ? 'More space' : 'Bigger', run: say(ordered.name === 'padding' || ordered.name === 'gap' ? 'more spacing' : 'bigger') });
      if (i > 0) out.push({ label: ordered.name === 'padding' || ordered.name === 'gap' ? 'Tighter' : 'Smaller', run: say(ordered.name === 'padding' || ordered.name === 'gap' ? 'tighter' : 'smaller') });
    }
    const variant = inspect.props.find((p) => p.options && ['variant', 'tone', 'emphasis'].includes(p.name));
    if (variant?.options) {
      for (const v of variant.options.filter((o) => o !== variant.value).slice(0, 2)) out.push({ label: `Make it ${VALUE_LABEL[v] ?? v}`, run: () => void controller.setProp(variant.name, v) });
    }
  }
  out.push({ label: 'Rename…', run: () => fill('rename to ') });
  if (out.length < 4) out.push({ label: 'Why does it look like this?', run: say('Why does this look the way it does?') });
  return out.slice(0, 4);
}

export function Dock() {
  const mode = useStudio((s) => s.mode);
  const selection = useStudio((s) => s.selection);
  const pins = useStudio((s) => s.pins);
  const inspect = useStudio((s) => s.inspect);
  const voice = useStudio((s) => s.voice);
  const focusInput = useStudio((s) => s.focusInput);
  const draft = useStudio((s) => s.draft);
  const history = useStudio((s) => s.history);
  const busy = useStudio((s) => !!s.request);
  const rec = useStudio((s) => s.recorder);
  const hasPreview = useStudio((s) => s.changes.some((c) => c.status === 'preview'));
  // An app linked by its address alone has no code here to change: no edit suggestions to dead-end on.
  const hasCode = useStudio((s) => s.status?.target.hasCode ?? true);
  const pipOn = useStudio((s) => s.camera.status === 'on' || s.camera.status === 'starting');
  const pip = useSettings((s) => s.camera);
  const avoid = pipOn && pip.corner.startsWith('b') ? PIP_SIZES[pip.pip].w + PIP_MARGIN * 2 : 0;
  const [text, setText] = useState('');
  const [hIndex, setHIndex] = useState(-1);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusInput) input.current?.focus();
  }, [focusInput]);

  const fill = (t: string) => {
    setText(t);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(t.length, t.length);
    });
  };

  // Check before sending: what you said arrives here to fix or send.
  useEffect(() => {
    if (draft) fill(draft.text);
  }, [draft?.n]);

  const suggestions = useMemo(() => {
    if (draft?.alternatives.length) return draft.alternatives.map((alt) => ({ label: alt, run: () => fill(alt) }));
    if (hasPreview || (!hasCode && mode !== 'record')) return [];
    return suggestionsFor(mode, inspect, !!selection, { expectations: rec.expectations.length, spec: !!rec.spec, failed: rec.run?.status === 'failed' }, fill);
  }, [mode, inspect, selection, rec.expectations.length, rec.spec, rec.run?.status, hasPreview, hasCode, draft]);

  // 1–4 run a suggestion when you are not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      const n = Number(e.key);
      if (n >= 1 && n <= suggestions.length && !draft?.alternatives.length) {
        e.preventDefault();
        suggestions[n - 1].run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [suggestions, draft]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    setHIndex(-1);
    // After a spoken draft, give Space back to push-to-talk.
    if (draft) input.current?.blur();
    controller.submitText(t);
  };

  const discard = () => {
    setText('');
    controller.clearDraft();
  };

  const listening = voice.state !== 'idle';
  const alternatives = !!draft?.alternatives.length;
  const placeholder = busy
    ? 'Ask the next thing: it runs when this one is done'
    : mode === 'record'
      ? 'Say what’s wrong: “this should show $80.80”'
      : pins.length
        ? `Say what to do with these ${pins.length}: “make this look like that”…`
        : selection
          ? `What should change about ${selection.name}${selection.text && selection.text.length < 24 ? ` “${selection.text}”` : ''}?`
          : mode === 'use'
            ? 'Ask about your app or describe a change…'
            : 'Point at something and say what to change, or type here';

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex flex-col items-center gap-2 px-4 transition-[padding] duration-200"
      style={avoid ? (pip.corner === 'bl' ? { paddingLeft: avoid } : { paddingRight: avoid }) : undefined}
    >
      <AnimatePresence>
        {suggestions.length > 0 && !listening && (
          <motion.div
            key="suggestions"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16 }}
            className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5"
            data-tour="suggestions"
          >
            {alternatives && <span className="glass inline-flex h-7 items-center rounded-[8px] px-2.5 text-[12px] text-fg-3">Or did you say</span>}
            {suggestions.map((s, i) => (
              <button
                key={s.label}
                data-hand
                onClick={s.run}
                className={cn('glass inline-flex h-7 items-center gap-2 rounded-[8px] pr-2.5 text-[12px] font-medium text-fg-2 transition-colors hover:text-fg', alternatives ? 'pl-2.5' : 'pl-1.5')}
              >
                {!alternatives && <Kbd className="h-4 min-w-4 text-[10px]">{i + 1}</Kbd>}
                {s.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <div className={cn('glass pointer-events-auto flex w-[min(660px,100%)] items-center gap-1.5 rounded-[14px] p-1.5 transition-shadow', listening && 'shadow-[var(--shadow-float),0_0_0_1.5px_var(--human-line)]')} data-tour="dock">
        <Tip label={listening ? 'Stop and send' : 'Talk: hold, or click for hands-free'} kbd="Space" side="top">
          <button
            data-hand
            aria-label="Talk"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              controller.pressTalk();
            }}
            onPointerUp={() => controller.releaseTalk()}
            onPointerCancel={() => controller.releaseTalk()}
            className={cn(
              'relative flex size-[34px] shrink-0 items-center justify-center rounded-[10px] transition-colors [&_svg]:size-[16px]',
              listening ? 'bg-human text-[#1b1203]' : 'bg-sunken text-fg-2 ring-1 ring-inset ring-line hover:text-fg',
            )}
          >
            <Mic />
          </button>
        </Tip>

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {pins.map((p, i) => (
            <span key={p.id} className="inline-flex h-6 max-w-[120px] shrink-0 items-center gap-1 rounded-[6px] bg-human-soft pl-1 pr-0.5 text-[11.5px] font-medium text-human-fg">
              <span className="flex size-4 items-center justify-center rounded-full bg-human font-mono text-[10px] text-[#1b1203]">{i + 1}</span>
              <span className="truncate">{p.name}</span>
              <button data-hand onClick={() => controller.deselect(p.id)} className="rounded-[4px] p-0.5 hover:bg-black/10" aria-label="Take out of the selection">
                <X className="size-3" />
              </button>
            </span>
          ))}
          {selection && !pins.length && (
            <span className="inline-flex h-6 max-w-[170px] shrink-0 items-center gap-1 rounded-[6px] bg-human-soft pl-2 pr-0.5 text-[11.5px] font-medium text-human-fg">
              <span className="truncate">{selection.text && selection.text.length < 18 ? `${selection.name} · ${selection.text}` : selection.name}</span>
              <button data-hand onClick={() => controller.select(null)} className="rounded-[4px] p-0.5 hover:bg-black/10" aria-label="Deselect">
                <X className="size-3" />
              </button>
            </span>
          )}
          <input
            ref={input}
            data-hand
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setHIndex(-1);
              if (!e.target.value) controller.clearDraft();
            }}
            onKeyDown={(e) => {
              const press = { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, isComposing: e.nativeEvent.isComposing };
              const decided = previewKey(press, text.trim() ? 'command-text' : 'command-empty', hasPreview ? 1 : 0);
              if (decided) {
                e.preventDefault();
                void (decided === 'keep' ? controller.keep('key') : controller.undo('key'));
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                discard();
                input.current?.blur();
              } else if (e.key === 'ArrowUp' && (!text || hIndex >= 0) && history.length) {
                e.preventDefault();
                const n = Math.min(history.length - 1, hIndex + 1);
                setHIndex(n);
                setText(history[n]);
              } else if (e.key === 'ArrowDown' && hIndex >= 0) {
                e.preventDefault();
                const n = hIndex - 1;
                setHIndex(n);
                setText(n >= 0 ? history[n] : '');
              }
            }}
            placeholder={placeholder}
            className="h-[34px] min-w-0 flex-1 bg-transparent px-1.5 text-[13.5px] text-fg outline-none placeholder:text-fg-3"
            aria-label="Describe a change"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {!text && !listening && hasPreview && (
          <span className="hidden shrink-0 pr-1 text-[11.5px] text-fg-3 sm:block" data-keys>
            {keepUndoHint(isMac)}
          </span>
        )}
        {!text && !listening && !hasPreview && (
          <span className="hidden shrink-0 items-center gap-1 pr-1 text-[11.5px] text-fg-3 sm:flex">
            hold <Kbd>Space</Kbd>
          </span>
        )}
        {draft && text && (
          <span className="hidden shrink-0 items-center gap-1 pr-1 text-[11.5px] text-fg-3 sm:flex" data-draft>
            <Kbd>↵</Kbd> send · <Kbd>Esc</Kbd> discard
          </span>
        )}
        <button
          data-hand
          aria-label="Send"
          disabled={!text.trim()}
          onClick={submit}
          className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-fg text-inverse transition-opacity disabled:opacity-25 [&_svg]:size-[15px]"
        >
          <ArrowUp />
        </button>
      </div>
    </div>
  );
}
