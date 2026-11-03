/**
 * The browser's speech recogniser (Chrome, Edge, Safari), with per-word
 * arrival times and several alternative transcripts per sentence.
 */
export interface Word {
  text: string;
  /** performance.now() when the word was said (aligned) or first appeared in the transcript. */
  t: number;
}

type SpeechState = 'idle' | 'listening' | 'finishing';

interface RecognitionAlternative {
  transcript: string;
  confidence?: number;
}
interface RecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart?: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone is blocked. Allow it in the address bar (and on macOS in System Settings → Privacy & Security → Microphone).',
  'service-not-allowed': 'Speech recognition is turned off in this browser. Use Chrome, or type instead.',
  'audio-capture': 'No microphone found.',
  network: 'The browser’s speech service can’t be reached (it needs the internet).',
  'language-not-supported': 'That language isn’t supported for speech here.',
};

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export class SpeechController {
  static supported(): boolean {
    return typeof window !== 'undefined' && !!ctor();
  }

  lang = 'en-US';
  onWords: ((words: Word[]) => void) | null = null;
  /** Final transcript plus alternatives (best first). */
  onFinal: ((text: string, words: Word[], alternatives: string[]) => void) | null = null;
  onError: ((code: string, message: string) => void) | null = null;
  /** The microphone is really capturing now. */
  onAudioStart: (() => void) | null = null;

  private rec: Recognition | null = null;
  private words: Word[] = [];
  /** Finished segments from earlier sessions (Chrome restarts long ones). */
  private finals = '';
  private current = '';
  private lastAlts: string[] = [];
  private lastPrefix = '';
  private want = false;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private done = true;
  state: SpeechState = 'idle';

  private setState(s: SpeechState): void {
    this.state = s;
  }

  start(): boolean {
    const C = ctor();
    if (!C) {
      this.onError?.('unsupported', 'This browser has no speech recognition. Use Chrome, or type your command.');
      return false;
    }
    // A previous session that never ended properly (after an error) gives way.
    if (this.state !== 'idle') this.cancel();
    this.words = [];
    this.finals = '';
    this.current = '';
    this.lastAlts = [];
    this.lastPrefix = '';
    this.want = true;
    this.done = false;
    this.spawn(C);
    this.setState('listening');
    return true;
  }

  private spawn(C: RecognitionCtor): void {
    const rec = new C();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    rec.onresult = (e) => this.handleResult(e);
    rec.onaudiostart = () => this.onAudioStart?.();
    rec.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return;
      this.want = false;
      this.onError?.(e.error, ERRORS[e.error] ?? `Speech recognition error: ${e.error}`);
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      // Chrome ends long sessions on its own; keep listening while the user still wants to talk.
      if (this.want) {
        this.finals = this.text();
        this.current = '';
        try {
          this.spawn(C);
          return;
        } catch {
          /* fall through to finish */
        }
      }
      this.finish();
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }

  private text(): string {
    return clean(`${this.finals} ${this.current}`);
  }

  private handleResult(e: RecognitionEvent): void {
    let text = '';
    let lastFinal = -1;
    for (let i = 0; i < e.results.length; i++) {
      text += ' ' + e.results[i][0].transcript;
      if (e.results[i].isFinal) lastFinal = i;
    }
    this.current = text;
    // Alternatives for the most recent finished sentence, with everything before it.
    if (lastFinal >= 0) {
      let prefix = this.finals;
      for (let i = 0; i < lastFinal; i++) prefix += ' ' + e.results[i][0].transcript;
      const r = e.results[lastFinal];
      const alts: string[] = [];
      for (let k = 0; k < r.length; k++) if (r[k]?.transcript) alts.push(clean(r[k].transcript));
      this.lastPrefix = clean(prefix);
      this.lastAlts = alts;
    }
    const full = this.text();
    const now = performance.now();
    const next = full ? full.split(' ') : [];
    // Keep the arrival time of words that were already there; new words arrive now.
    this.words = next.map((w, i) => ({ text: w, t: this.words[i]?.t ?? now }));
    this.onWords?.(this.words);
  }

  /** Stop listening and deliver the final transcript. */
  stop(): void {
    if (this.state !== 'listening') return;
    this.want = false;
    this.setState('finishing');
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    // If the browser never sends `end`, finish with what we have.
    this.finishTimer = setTimeout(() => this.finish(), 1600);
  }

  /** Stop without delivering anything. */
  cancel(): void {
    this.want = false;
    this.done = true;
    if (this.finishTimer) clearTimeout(this.finishTimer);
    try {
      this.rec?.abort();
    } catch {
      /* ignore */
    }
    this.rec = null;
    this.setState('idle');
  }

  private finish(): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.rec = null;
    if (this.done) return;
    this.done = true;
    const text = this.text();
    const alternatives = [text];
    for (const alt of this.lastAlts.slice(1)) {
      const full = clean(`${this.lastPrefix} ${alt}`);
      if (full && !alternatives.includes(full)) alternatives.push(full);
    }
    this.setState('idle');
    this.onFinal?.(text, this.words, text ? alternatives : []);
  }
}
