import { describe, expect, it } from 'vitest';
import { AudioCapture, RATE } from '../../src/core/voice/capture';
import { alignWords, commandCandidates, isClipped, pick, plausible, sameWords, soundAlikes, soundKey, soundsLike, understood, type Candidate } from '../../src/core/voice/choose';

const browser = (...texts: string[]): Candidate[] => texts.map((text, rank) => ({ text, source: 'browser', rank }));
const device = (text: string): Candidate => ({ text, source: 'device', rank: 0 });
const command = (text: string): Candidate => ({ text, source: 'command', rank: 0 });

describe('comparing transcripts', () => {
  it('ignores case and punctuation', () => {
    expect(sameWords('Make this bigger.', 'make this bigger')).toBe(true);
    expect(sameWords('This should show $80.80.', 'this should show $80.80')).toBe(true);
    expect(sameWords('make this bigger', 'make it bigger')).toBe(false);
  });

  it('spots a transcript that lost its first or last words', () => {
    expect(isClipped('this bigger', 'Make this bigger.')).toBe(true);
    expect(isClipped('make this', 'Make this bigger.')).toBe(true);
    expect(isClipped('this bigger', 'Make this beggar.')).toBe(true);
    expect(isClipped('make it bigger', 'Make this bigger.')).toBe(false);
    expect(isClipped('make this bigger', 'Make this bigger.')).toBe(false);
  });
});

describe('words that sound alike', () => {
  it('ignores vowels and voicing, which accents and recognisers blur', () => {
    expect(soundKey('bigger')).toBe(soundKey('beggar'));
    expect(soundKey('bigger')).toBe(soundKey('baker'));
    expect(soundKey('red')).toBe(soundKey('read'));
    expect(soundKey('pink')).toBe(soundKey('bink'));
    expect(soundKey('bigger')).not.toBe(soundKey('figure'));
    expect(soundKey('header')).not.toBe(soundKey('hide'));
  });

  it('offers the studio word where one is expected', () => {
    expect(soundAlikes('Make this beggar.')).toEqual(['Make this bigger.']);
    expect(soundAlikes('make it read')).toContain('make it red');
    expect(soundAlikes('make it smell')).toEqual(['make it small']);
    expect(soundAlikes('Cape.')).toContain('Keep.');
    // Not in ordinary sentences, and not for words the studio already knows.
    expect(soundAlikes('add a header')).toEqual([]);
    expect(soundAlikes('Why is the total Rome?')).toEqual([]);
    expect(soundAlikes('make it red')).toEqual([]);
  });

  it('hears a command in words run together', () => {
    expect(soundsLike('And you?', 'Undo.')).toBe(true);
    expect(soundsLike('and do', 'Undo.')).toBe(true);
    expect(soundsLike('make this bigger', 'Undo.')).toBe(false);
  });
});

describe('what the studio understands', () => {
  it.each(['keep it', 'Undo.', 'this should show $80.80', 'Why is the total wrong?', 'make this bigger', 'rename this to use code', 'make it red', 'make the pay button green'])('“%s”', (t) => {
    expect(understood(t)).toBe(true);
  });

  it.each(['', 'make this figure', 'the weather today', 'Pansel.'])('not “%s”', (t) => {
    expect(understood(t)).toBe(false);
  });
});

describe('telling words from noise', () => {
  it('rejects what models hear in breaths and coughs', () => {
    expect(plausible('Thank you.', -0.2)).toBe(false);
    expect(plausible('you', -0.1)).toBe(false);
    expect(plausible('the the the the the', -0.3)).toBe(false);
    expect(plausible('', 0)).toBe(false);
  });

  it('accepts confident transcripts, with a higher bar when nothing else heard speech', () => {
    expect(plausible('Make this bigger.', -0.2)).toBe(true);
    expect(plausible('Make this bigger.', -0.9)).toBe(true);
    expect(plausible('Make this bigger.', -0.9, true)).toBe(false);
    expect(plausible('Pansel.', -1.6)).toBe(false);
  });
});

describe('picking what you said', () => {
  it('trusts the browser when there is nothing to compare', () => {
    expect(pick(browser('make it red', 'make it read'), null)?.text).toBe('make it red');
    // …unless a lower guess is the one that makes sense.
    expect(pick(browser('make this figure', 'make this bigger'), null)?.text).toBe('make this bigger');
  });

  it('prefers the on-device transcript when the browser misheard', () => {
    const c = [...browser('make this figure'), device('Make this bigger.')];
    expect(pick(c, { 'make this figure': -1.4, 'Make this bigger.': -0.15 })?.text).toBe('Make this bigger.');
  });

  it('keeps the browser’s transcript for a long request both heard about the same', () => {
    const said = 'add a loading spinner to the checkout button';
    const c = [...browser(said), device('Add a loading spinner to the check out button.')];
    expect(pick(c, { [said]: -0.35, 'Add a loading spinner to the check out button.': -0.2 })?.text).toBe(said);
  });

  it('prefers the fuller transcript when the browser started listening late', () => {
    const c = [...browser('this bigger'), device('Make this bigger.')];
    expect(pick(c, { 'this bigger': -0.9, 'Make this bigger.': -0.15 })?.text).toBe('Make this bigger.');
  });

  it('rescues a short command that free transcription missed', () => {
    const c = [device('And do.'), command('Undo.'), command('Undo that.'), command('Keep it.')];
    expect(pick(c, { 'And do.': -0.31, 'Undo.': -2.14, 'Undo that.': -3.5, 'Keep it.': -4.1 })?.text).toBe('Undo.');
  });

  it('never picks a command the audio doesn’t support, or one it can’t tell from another', () => {
    expect(pick([command('Stop.'), command('Help.')], { 'Stop.': -4.4, 'Help.': -4.2 })).toBeNull();
    // “Keep it” and “undo” fit about equally well: do neither.
    expect(pick([command('Undo.'), command('Keep it.')], { 'Undo.': -1.9, 'Keep it.': -2.1 })).toBeNull();
    expect(pick([], {})).toBeNull();
  });

  it('accepts a weaker match when what was heard sounds like the command', () => {
    const scores = { 'And you?': -0.5, 'Undo.': -3.0, 'Cancel.': -6.3 };
    expect(pick([device('And you?'), command('Undo.'), command('Cancel.')], scores)?.text).toBe('Undo.');
    expect(pick([device('Hello there.'), command('Undo.'), command('Cancel.')], { ...scores, 'Hello there.': -0.5 })?.text).toBe('Hello there.');
  });

  it('weighs a command as a command, though a sound-alike of what was heard gave the same words', () => {
    // “Undo”, heard as one word that sounds like it: the sound-alike is “Undo.” itself.
    const heard = device('Andi.');
    const alike: Candidate = { text: 'Undo.', source: 'variant', rank: 0, from: heard };
    const scored = { 'Undo.': -2.05, 'Undo that.': -3.69, 'Run the test.': -5.19 };
    const commands = commandCandidates([heard, alike], scored);
    expect(commands.map((c) => c.text)).toEqual(['Undo.', 'Undo that.', 'Run the test.']);
    // As a sound-alike it explains the audio much less well than what was heard; as a command it is clearly the one said.
    expect(pick([heard, alike], { 'Andi.': -0.83, ...scored })?.text).toBe('Andi.');
    expect(pick([heard, alike, ...commands], { 'Andi.': -0.83, ...scored })).toMatchObject({ text: 'Undo.', source: 'command' });
    // What a recogniser heard as it is needs no rescue: it is not weighed twice.
    expect(commandCandidates([device('Undo.')], scored).map((c) => c.text)).toEqual(['Undo that.', 'Run the test.']);
    expect(commandCandidates(browser('undo that', 'Undo that.'), scored).map((c) => c.text)).toEqual(['Undo.', 'Run the test.']);
  });

  it('swaps in a sound-alike studio word when the audio supports it', () => {
    const heard = device('Make this beggar.');
    const fixed: Candidate = { text: 'Make this bigger.', source: 'variant', rank: 0, from: heard };
    expect(pick([heard, fixed], { 'Make this beggar.': -0.25, 'Make this bigger.': -0.32 })?.text).toBe('Make this bigger.');
    // …but not when the audio clearly says something else.
    expect(pick([heard, fixed], { 'Make this beggar.': -0.25, 'Make this bigger.': -1.6 })?.text).toBe('Make this beggar.');
  });

  it('a corrected variant of a clipped browser transcript keeps its standing', () => {
    const clipped = browser('this beggar')[0];
    const full = device('Make this beggar.');
    const fixed: Candidate = { text: 'Make this bigger.', source: 'variant', rank: 0, from: full };
    expect(pick([clipped, full, fixed], { 'this beggar': -2.2, 'Make this beggar.': -0.25, 'Make this bigger.': -0.3 })?.text).toBe('Make this bigger.');
  });
});

describe('word timing', () => {
  it('spreads words across the stretch of speech, in order', () => {
    const w = alignWords('make this look like that', 1000, 2000);
    expect(w.map((x) => x.text)).toEqual(['make', 'this', 'look', 'like', 'that']);
    for (let i = 1; i < w.length; i++) expect(w[i].t).toBeGreaterThan(w[i - 1].t);
    expect(w[0].t).toBeGreaterThan(1000);
    expect(w.at(-1)!.t).toBeLessThan(2000);
  });
});

describe('finding speech in the recording', () => {
  const BLOCK_MS = (512 / RATE) * 1000;
  /** Feed blocks: each entry is a loudness (RMS) for one 32 ms block. */
  function feed(cap: AudioCapture, levels: number[], t0 = 0): number {
    let t = t0;
    for (const rms of levels) {
      const data = new Float32Array(512);
      for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 3) * rms * Math.SQRT2;
      t += BLOCK_MS;
      cap.ingest(data, t);
    }
    return t;
  }
  const quiet = (n: number) => Array(n).fill(0.0006);
  const loud = (n: number) => Array(n).fill(0.06);

  it('finds where speech starts and ends', () => {
    const cap = new AudioCapture();
    const end = feed(cap, [...quiet(30), ...loud(25), ...quiet(20)]);
    const v = cap.voiced(0, end)!;
    expect(v.start).toBeCloseTo(30 * BLOCK_MS, -1);
    expect(v.end).toBeCloseTo(55 * BLOCK_MS, -1);
    expect(cap.peak(0, end)).toBeGreaterThan(0.05);
  });

  it('ignores a key click', () => {
    const cap = new AudioCapture();
    const end = feed(cap, [...quiet(30), 0.2, ...quiet(30)]);
    expect(cap.voiced(0, end)).toBeNull();
  });

  it('keeps a word that started just before the press', () => {
    const cap = new AudioCapture();
    const end = feed(cap, [...quiet(30), ...loud(20), ...quiet(10)]);
    const pressAt = 36 * BLOCK_MS;
    expect(cap.voiced(pressAt - 600, end, pressAt)!.start).toBeCloseTo(30 * BLOCK_MS, -1);
  });

  it('leaves out a remark that ended well before the press', () => {
    const cap = new AudioCapture();
    const end = feed(cap, [...quiet(10), ...loud(8), ...quiet(12), ...loud(15), ...quiet(10)]);
    const pressAt = 29 * BLOCK_MS;
    const v = cap.voiced(pressAt - 600, end, pressAt)!;
    expect(v.start).toBeCloseTo(30 * BLOCK_MS, -1);
  });

  it('treats a steady hum as background, not speech', () => {
    const cap = new AudioCapture();
    const end = feed(cap, Array(400).fill(0.02));
    expect(cap.voiced(end - 2000, end)).toBeNull();
  });
});
