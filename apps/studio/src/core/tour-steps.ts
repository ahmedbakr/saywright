/**
 * The quick-start tour as plain functions, so it can be checked without a browser: its steps for the app that is
 * open, whether the person has done what a step asks, each step's words (they follow the AI, the microphone and the
 * computer's keys), when Escape is the tour's to take, and where a step's card goes beside what it points at.
 */
import type { StatusResponse } from '@shared/api';
import { shortcut } from '@/lib/format';

export type TourStep = 'point' | 'say' | 'keep' | 'changes' | 'ai' | 'more' | 'done';

/** The steps for the open app. One linked by its address alone has no code here to change, so it skips those. */
export function tourSteps(hasCode: boolean): TourStep[] {
  return hasCode ? ['point', 'say', 'keep', 'changes', 'ai', 'more', 'done'] : ['point', 'ai', 'more', 'done'];
}

/** What the steps watch: what is selected, the previews waiting, and how many changes were kept or undone. */
export interface TourMark {
  selected: number | null;
  previews: string[];
  decided: number;
}

export function markOf(s: { selection: { id: number } | null; changes: { id: string; status: string }[] }): TourMark {
  return {
    selected: s.selection?.id ?? null,
    previews: s.changes.filter((c) => c.status === 'preview').map((c) => c.id),
    decided: s.changes.filter((c) => c.status !== 'preview').length,
  };
}

/** Whether the person did what the step asks since it began. The steps that only show something wait for Next. */
export function stepDone(step: TourStep, from: TourMark, now: TourMark): boolean {
  if (step === 'point') return now.selected !== null && now.selected !== from.selected;
  if (step === 'say') return now.previews.some((id) => !from.previews.includes(id));
  if (step === 'keep') return now.decided > from.decided;
  return false;
}

/** What the words of a step depend on. */
export interface TourContext {
  /** The open app is the sample shop. */
  sample: boolean;
  hasCode: boolean;
  /** Edit mode, where clicking selects. */
  editing: boolean;
  /** Talking works here (a microphone, and speech recognition). */
  mic: boolean;
  /** A preview is waiting for keep or undo. */
  waiting: boolean;
  mac: boolean;
  ai: Pick<StatusResponse['ai'], 'ready' | 'source' | 'who'> | null;
}

interface StepText {
  title: string;
  body: string;
}

const PLANS: Record<string, string> = { 'claude-code': 'Claude', codex: 'ChatGPT', 'gemini-cli': 'Gemini', gemini: 'Gemini' };
const ON_THIS_COMPUTER = new Set(['ollama', 'lmstudio']);

/** Who answers what quick edits can't do, and what that costs. */
function yourAi(ai: TourContext['ai']): string {
  const who = ai?.who;
  if (ai?.source === 'fake') return 'Anything bigger goes to the test stand-in, which costs nothing.';
  if (!who) return 'Anything bigger goes to your AI.';
  if (who.plan) return `Anything bigger goes to ${PLANS[who.connection] ?? who.label} on your plan, with no extra bill. What it used today shows here.`;
  if (ON_THIS_COMPUTER.has(who.connection)) return `Anything bigger goes to ${who.model}, on this computer: free.`;
  return `Anything bigger goes to ${who.model} on your API key, paid per request. Today’s spend shows here; set a budget in Settings.`;
}

export function stepText(step: TourStep, c: TourContext): StepText {
  const enter = c.mac ? 'Return' : 'Enter';
  switch (step) {
    case 'point': {
      const where = c.hasCode ? ' and the file and line it comes from' : '';
      if (!c.editing) return { title: 'Point at something', body: `This is your app, running live. Press E for Edit mode, then click anything in it. The tag shows what it is${where}.` };
      const what = c.sample ? ', like the Pay button' : ': a button, a heading, a price';
      return { title: 'Point at something', body: `This is your app, running live. Click anything in it${what}. The tag shows what it is${where}.` };
    }
    case 'say': {
      const how = c.mic ? `Hold Space and say it, or type it here and press ${enter}` : `Type it here and press ${enter}`;
      return { title: 'Say what to change', body: `${how}: “make it smaller”, “rename to Place order”. Keys 1 to 4 run a suggestion.` };
    }
    case 'keep': {
      const what = c.waiting ? 'This is a live preview: your file and your app have already changed.' : 'Each change arrives as a live preview: your file and your app change at once.';
      return { title: 'Keep it or undo it', body: `${what} ${enter} keeps it, ${shortcut('mod+z', c.mac)} puts both back.` };
    }
    case 'changes':
      return { title: 'See the code', body: 'Every change is listed here with its diff and its file. Nothing is committed unless you turn that on in Settings.' };
    case 'ai':
      if (!c.ai?.ready)
        return {
          title: 'Bigger changes need an AI',
          body: 'Size, variant, text, move and remove are quick edits: instant, free and offline. For anything else, connect the AI you already pay for, or an API key with a budget.',
        };
      return { title: 'Your AI', body: `Quick edits stay instant and free. ${yourAi(c.ai)}` };
    case 'more': {
      const panel = c.ai?.ready
        ? 'In the panel, Autopilot lets the AI try your app like a tester, and Experts review the page for SEO, content, UX and accessibility.'
        : 'In the panel, Experts review the page for SEO, content, UX and accessibility; with an AI connected, Autopilot tries your app like a tester.';
      const link = c.hasCode ? '' : ' Link the app’s folder to fix what they find.';
      return { title: 'Test and review', body: `Record session: use your app and talk, then get a report with evidence. ${panel}${link}` };
    }
    case 'done':
      return { title: 'You’re set', body: `Press ? for phrases and shortcuts, and ${shortcut('mod+k', c.mac)} to find any action by name. Take this tour again from Help.` };
  }
}

/**
 * Escape ends the tour unless the studio is running something Escape stops (a replay, Autopilot, listening, a
 * request): those come first. A selection or a note on the island doesn't hold it: the tour's card sits above them.
 */
export function escapeEndsTour(s: { replay: unknown; autopilot: unknown; voice: { state: string }; request: unknown }): boolean {
  return !s.replay && !s.autopilot && s.voice.state === 'idle' && !s.request;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Beside what the card is about, or inside it (its bottom left corner, for something as big as the app). */
export type Side = 'top' | 'bottom' | 'left' | 'right' | 'inside';

interface Placement {
  x: number;
  y: number;
  side: Side;
  /** Where the arrow meets the card's edge, from the card's start (px); null: no arrow. */
  arrow: number | null;
}

const GAP = 12;
const MARGIN = 12;
const INSET = 16;
/** The arrow keeps clear of the card's rounded corners. */
const CORNER = 18;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, Math.max(lo, hi)));

function room(side: Exclude<Side, 'inside'>, a: Box, view: { w: number; h: number }): number {
  if (side === 'bottom') return view.h - (a.y + a.h);
  if (side === 'top') return a.y;
  if (side === 'right') return view.w - (a.x + a.w);
  return a.x;
}

function beside(side: Exclude<Side, 'inside'>, a: Box, card: { w: number; h: number }, view: { w: number; h: number }): Placement {
  if (side === 'top' || side === 'bottom') {
    const x = clamp(a.x + a.w / 2 - card.w / 2, MARGIN, view.w - card.w - MARGIN);
    const y = clamp(side === 'bottom' ? a.y + a.h + GAP : a.y - GAP - card.h, MARGIN, view.h - card.h - MARGIN);
    return { x, y, side, arrow: clamp(a.x + a.w / 2 - x, CORNER, card.w - CORNER) };
  }
  const y = clamp(a.y + a.h / 2 - card.h / 2, MARGIN, view.h - card.h - MARGIN);
  const x = clamp(side === 'right' ? a.x + a.w + GAP : a.x - GAP - card.w, MARGIN, view.w - card.w - MARGIN);
  return { x, y, side, arrow: clamp(a.y + a.h / 2 - y, CORNER, card.h - CORNER) };
}

/** Where a card of `card` size goes for `anchor`: the first of `sides` it fits on, else the side with the most room, always on screen. */
export function placeCard(anchor: Box, card: { w: number; h: number }, view: { w: number; h: number }, sides: Side[]): Placement {
  for (const side of sides) {
    if (side === 'inside') {
      const x = clamp(anchor.x + INSET, MARGIN, view.w - card.w - MARGIN);
      const y = clamp(anchor.y + anchor.h - card.h - INSET, MARGIN, view.h - card.h - MARGIN);
      return { x, y, side, arrow: null };
    }
    const need = (side === 'top' || side === 'bottom' ? card.h : card.w) + GAP + MARGIN;
    if (room(side, anchor, view) >= need) return beside(side, anchor, card, view);
  }
  const roomiest = (['bottom', 'top', 'right', 'left'] as const).reduce((best, s) => (room(s, anchor, view) > room(best, anchor, view) ? s : best));
  return beside(roomiest, anchor, card, view);
}
