/** Quiet UI sounds that confirm hands-free actions without looking. Synthesised, no assets. */
type Cue = 'listen' | 'send' | 'tap' | 'pick' | 'keep' | 'undo' | 'error';

let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundsEnabled(on: boolean): void {
  enabled = on;
}

function tone(freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'sine', to?: number): void {
  if (!ctx) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export function play(cue: Cue): void {
  if (!enabled) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    return;
  }
  switch (cue) {
    case 'listen':
      tone(660, 0, 0.09, 0.05, 'sine', 990);
      break;
    case 'send':
      tone(990, 0, 0.08, 0.04, 'sine', 740);
      break;
    case 'tap':
      tone(1800, 0, 0.03, 0.025, 'triangle');
      break;
    case 'pick':
      tone(1320, 0, 0.04, 0.03, 'triangle');
      tone(1760, 0.05, 0.05, 0.03, 'triangle');
      break;
    case 'keep':
      tone(784, 0, 0.12, 0.045);
      tone(1175, 0.07, 0.16, 0.04);
      break;
    case 'undo':
      tone(523, 0, 0.14, 0.045, 'sine', 392);
      break;
    case 'error':
      tone(220, 0, 0.18, 0.05, 'triangle', 180);
      break;
  }
}
