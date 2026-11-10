import { describe, expect, it } from 'vitest';
import { escapeEndsTour, markOf, placeCard, stepDone, stepText, tourSteps, type TourContext, type TourStep } from '../../src/core/tour-steps';

const API = { ready: true, source: 'anthropic', who: { connection: 'anthropic', label: 'Anthropic API', model: 'Claude Sonnet 4.5', plan: false } };
const ctx = (over: Partial<TourContext> = {}): TourContext => ({ sample: false, hasCode: true, editing: true, mic: true, waiting: true, mac: false, ai: API, ...over });
const words = (step: TourStep, over: Partial<TourContext> = {}) => {
  const t = stepText(step, ctx(over));
  return `${t.title} · ${t.body}`;
};

const studio = (selection: number | null, changes: [string, string][]) => ({ selection: selection === null ? null : { id: selection }, changes: changes.map(([id, status]) => ({ id, status })) });

describe('the quick-start tour', () => {
  it('has eight steps on an app with code here, and skips the code ones for an app linked by its address alone', () => {
    expect(tourSteps(true)).toEqual(['point', 'say', 'keep', 'changes', 'ai', 'test', 'more', 'done']);
    expect(tourSteps(false)).toEqual(['point', 'ai', 'more', 'done']);
  });

  it('moves on from pointing once something new is selected, not for what was already selected', () => {
    const from = markOf(studio(null, []));
    expect(stepDone('point', from, markOf(studio(null, [])))).toBe(false);
    expect(stepDone('point', from, markOf(studio(7, [])))).toBe(true);
    const already = markOf(studio(7, []));
    expect(stepDone('point', already, markOf(studio(7, [])))).toBe(false);
    expect(stepDone('point', already, markOf(studio(9, [])))).toBe(true);
  });

  it('moves on from saying when a new preview waits, and from keeping once a preview is kept or undone', () => {
    const before = markOf(studio(7, [['old', 'preview']]));
    expect(stepDone('say', before, markOf(studio(7, [['old', 'preview']])))).toBe(false);
    expect(stepDone('say', before, markOf(studio(7, [['new', 'preview'], ['old', 'preview']])))).toBe(true);

    const waiting = markOf(studio(7, [['c1', 'preview']]));
    expect(stepDone('keep', waiting, markOf(studio(7, [['c1', 'preview']])))).toBe(false);
    expect(stepDone('keep', waiting, markOf(studio(7, [['c1', 'kept']])))).toBe(true);
    expect(stepDone('keep', waiting, markOf(studio(7, [['c1', 'undone']])))).toBe(true);
  });

  it('waits for Next on the steps that only show something', () => {
    const from = markOf(studio(null, []));
    const busy = markOf(studio(3, [['a', 'preview'], ['b', 'kept']]));
    for (const step of ['changes', 'ai', 'more', 'done'] as const) expect(stepDone(step, from, busy), step).toBe(false);
  });
});

describe('the tour’s words', () => {
  it('ask to talk only where a microphone works; typing is always there', () => {
    expect(words('say', { mic: true })).toContain('Hold Space and say it, or type it here and press Enter');
    expect(words('say', { mic: false })).toContain('Type it here and press Enter');
    expect(words('say', { mic: false })).not.toContain('Space');
  });

  it('name the keys as this computer does', () => {
    expect(words('keep')).toContain('Enter keeps it, Ctrl Z puts both back.');
    expect(words('keep', { mac: true })).toContain('Return keeps it, ⌘Z puts both back.');
    expect(words('done')).toContain('Press ? for phrases and shortcuts, and Ctrl K to find any action by name.');
    expect(words('done', { mac: true })).toContain('⌘K');
  });

  it('say what a preview is, whether or not one is waiting', () => {
    expect(words('keep', { waiting: true })).toContain('This is a live preview: your file and your app have already changed.');
    expect(words('keep', { waiting: false })).toContain('Each change arrives as a live preview');
  });

  it('without an AI: quick edits are free, the rest needs one; with one: who answers and what it costs', () => {
    expect(words('ai', { ai: { ready: false, source: null, who: null } })).toBe(
      'Bigger changes need an AI · Size, variant, text, move and remove are quick edits: instant, free and offline. For anything else, connect the AI you already pay for, or an API key with a budget.',
    );
    expect(words('ai')).toContain('Anything bigger goes to Claude Sonnet 4.5 on your API key, paid per request.');
    expect(words('ai', { ai: { ready: true, source: 'claude-code', who: { connection: 'claude-code', label: 'Claude Code', model: 'Sonnet', plan: true } } })).toContain('goes to Claude on your plan, with no extra bill');
    expect(words('ai', { ai: { ready: true, source: 'ollama', who: { connection: 'ollama', label: 'Ollama', model: 'qwen3-coder', plan: false } } })).toContain('goes to qwen3-coder, on this computer: free');
    expect(words('ai', { ai: { ready: true, source: 'fake', who: { connection: 'fake', label: 'Test stand-in', model: 'fake', plan: false } } })).toContain('the test stand-in, which costs nothing');
    // Autopilot needs one.
    expect(words('more', { ai: { ready: false, source: null, who: null } })).toContain('with an AI connected, Autopilot tries your app like a tester');
  });

  it('say the bug, get the test: what the studio is for, on the sample shop’s own bug and on any app', () => {
    expect(words('test', { sample: true })).toBe(
      'Say the bug, get the test · Press R for Write test. Try it here: type SAVE20 as the coupon and apply it, then point at the total and say “this should show $80.80”. You get a Playwright test that fails on the bug. Your AI’s fix is kept only when that same test passes.',
    );
    expect(words('test')).toContain('Use your app as usual, then point at a value that is wrong and say what it should be: “this should show $80.80”.');
    // Nothing is promised of an AI that isn't connected.
    expect(words('test', { ai: { ready: false, source: null, who: null } })).toContain('With an AI connected, its fix is kept only when that same test passes.');
  });

  it('point at the app: Edit mode first, the sample shop’s Pay button, and no file and line for an address alone', () => {
    expect(words('point', { editing: false })).toContain('Press E for Edit mode, then click anything in it.');
    expect(words('point', { sample: true })).toContain('Click anything in it, like the Pay button.');
    expect(words('point')).toContain('The tag shows what it is and the file and line it comes from.');
    expect(words('point', { hasCode: false })).toContain('The tag shows what it is.');
    expect(words('more', { hasCode: false })).toContain('Link the app’s folder to fix what they find.');
  });

  it('are plain: curly quotes and apostrophes, no exclamation marks', () => {
    const contexts: Partial<TourContext>[] = [{}, { mic: false, mac: true, waiting: false, sample: true }, { editing: false, hasCode: false, ai: { ready: false, source: null, who: null } }];
    for (const step of tourSteps(true))
      for (const c of contexts) {
        const text = words(step, c);
        expect(text, `${step}: ${text}`).not.toMatch(/['"!]/);
      }
  });
});

describe('Escape and the tour', () => {
  const idle = { replay: null, autopilot: null, voice: { state: 'idle' }, request: null };
  it('ends the tour when nothing Escape stops is running; a running thing comes first', () => {
    expect(escapeEndsTour(idle)).toBe(true);
    expect(escapeEndsTour({ ...idle, voice: { state: 'listening' } })).toBe(false);
    expect(escapeEndsTour({ ...idle, request: { id: 'r1' } })).toBe(false);
    expect(escapeEndsTour({ ...idle, autopilot: { step: 1 } })).toBe(false);
    expect(escapeEndsTour({ ...idle, replay: { step: 2 } })).toBe(false);
  });
});

describe('where a tour card goes', () => {
  const view = { w: 1440, h: 900 };

  it('below what it points at, its arrow at that thing’s middle', () => {
    expect(placeCard({ x: 1160, y: 10, w: 140, h: 26 }, { w: 340, h: 120 }, view, ['bottom'])).toEqual({ x: 1060, y: 48, side: 'bottom', arrow: 170 });
  });

  it('stays on screen at the window’s edge, its arrow still on the button', () => {
    expect(placeCard({ x: 1349, y: 10, w: 26, h: 26 }, { w: 340, h: 120 }, view, ['bottom'])).toEqual({ x: 1088, y: 48, side: 'bottom', arrow: 274 });
  });

  it('above when there is no room below', () => {
    expect(placeCard({ x: 200, y: 842, w: 660, h: 46 }, { w: 340, h: 150 }, view, ['bottom', 'top'])).toEqual({ x: 360, y: 680, side: 'top', arrow: 170 });
  });

  it('beside, to the left', () => {
    expect(placeCard({ x: 1052, y: 100, w: 376, h: 420 }, { w: 340, h: 140 }, view, ['left'])).toEqual({ x: 700, y: 240, side: 'left', arrow: 70 });
  });

  it('inside something as big as the app, in its bottom left corner, with no arrow', () => {
    expect(placeCard({ x: 28, y: 110, w: 984, h: 686 }, { w: 340, h: 165 }, view, ['inside'])).toEqual({ x: 44, y: 615, side: 'inside', arrow: null });
  });

  it('on screen even when it fits nowhere', () => {
    const p = placeCard({ x: 0, y: 0, w: 1440, h: 900 }, { w: 340, h: 200 }, view, ['bottom']);
    expect(p.y).toBeGreaterThanOrEqual(12);
    expect(p.y + 200).toBeLessThanOrEqual(888);
    expect(p.x + 340).toBeLessThanOrEqual(1428);
  });
});
