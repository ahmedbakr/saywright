/**
 * Runs a test session from a page: starts it on the studio server, streams
 * narration and screen capture to it, and follows its live updates. Used by
 * the studio and by the recorder inside the app's own tab.
 */
import { MicStream } from './mic';
import { ScreenCapture } from './screen';

export { MicStream } from './mic';
export { ScreenCapture } from './screen';

export type NarrationLang = 'en' | 'ar' | 'auto';

interface StartOptions {
  /** The studio server, e.g. http://localhost:7357. */
  endpoint: string;
  name?: string;
  lang: NarrationLang;
  appUrl: string;
  source: 'studio' | 'app';
  mic: boolean;
  micDeviceId?: string | null;
  /** Ask to share the tab for screenshots (and video when `video`). */
  screen: boolean;
  video: boolean;
  /** Limit the picture to this element (the app's frame in the studio). */
  crop?: Element | null;
  /** Stop a session that is recording elsewhere and start this one. */
  replace?: boolean;
  /**
   * Seconds to count down before recording, while the microphone opens and is
   * heard, the speech model loads and the app connects. Recording starts when
   * the count is over and all of that is ready (or on startNow). 0: at once.
   */
  countdown?: number;
  /** Whether the app is there to record (the studio's frame has connected). */
  appReady?: () => boolean;
  /**
   * Called as soon as the session exists, before the microphone and the screen
   * are ready (they can take a moment): start recording the app's events here,
   * so nothing done meanwhile is missed.
   */
  onCreated?: (id: string, key: string) => void | Promise<void>;
}

interface LiveCounts {
  events: number;
  clicks: number;
  errors: number;
  failedRequests: number;
  frustration: number;
  marks: number;
  speech: number;
  shots: number;
}

/** Whether narration is being transcribed as it is spoken: the model is loading, it is, or it can't be on this computer. */
export type NarrationState = 'loading' | 'live' | 'off';

/** Getting ready to record: the count, and what is checked meanwhile. */
export interface Countdown {
  /** Seconds left; 0 once counted down (then `waiting` says what recording still waits for, if anything). */
  left: number;
  /** The whole count, in seconds. */
  total: number;
  mic: 'off' | 'opening' | 'checking' | 'ok' | 'quiet' | 'blocked' | 'failed';
  screen: 'off' | 'ok' | 'denied' | 'unsupported';
  speech: 'off' | 'loading' | 'ok' | 'unavailable';
  app: 'ok' | 'waiting';
  waiting: string | null;
  /** What starting anyway means now ("Start now", "Record without voice"). */
  goLabel: string;
}

/** What the voice indicator says right now. */
export interface VoiceStatus {
  state: 'off' | 'starting' | 'blocked' | 'unavailable' | 'paused' | 'silent' | 'speaking' | 'transcribing' | 'heard' | 'loading' | 'listening' | 'untranscribed';
  text: string;
  /** More about it, for a tooltip. */
  hint: string;
  tone: 'ok' | 'warn' | 'bad' | 'quiet';
}

export interface ClientState {
  id: string | null;
  status: 'idle' | 'starting' | 'recording' | 'stopping' | 'processing' | 'ready' | 'failed';
  stage: string;
  startedAt: number;
  counts: LiveCounts;
  audioSeconds: number;
  mic: 'off' | 'starting' | 'on' | 'denied' | 'error';
  screen: 'off' | 'on' | 'denied' | 'unsupported';
  paused: boolean;
  /** The last few things said, newest last. */
  captions: { t: number; text: string }[];
  lastIssue: { t: number; text: string } | null;
  error: string | null;
  /** Uploads waiting to go out (audio, video, pictures). */
  backlog: number;
  /** Pieces of narration or video left out because the studio couldn't be reached for too long. */
  lost?: number;
  /** Starting failed because another session is recording (start again with replace to take over). */
  busy?: boolean;
  /** Whether what is said is transcribed as it is said (from the studio). */
  narration?: NarrationState;
  /** When the last sentence came back transcribed (ms). */
  heardAt?: number;
  /** While starting: the countdown and readiness checks (null once recording, or with no countdown). */
  countdown?: Countdown | null;
}

const PENDING_AUDIO = 'saywright.session.audio';
/** How long starting waits for the browser's “share this tab” question to be answered. */
export const SCREEN_WAIT_MS = 30_000;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const ZERO: LiveCounts = { events: 0, clicks: 0, errors: 0, failedRequests: 0, frustration: 0, marks: 0, speech: 0, shots: 0 };

export const initialState: ClientState = { id: null, status: 'idle', stage: '', startedAt: 0, counts: ZERO, audioSeconds: 0, mic: 'off', screen: 'off', paused: false, captions: [], lastIssue: null, error: null, backlog: 0 };

/**
 * Uploads that must arrive in order (audio, video), retried until they do.
 * Bodies go as text/plain (the studio reads these routes as raw bytes): no
 * CORS preflight per request, and the same request works from sendBeacon.
 */
class OrderedUploads {
  queue: { url: string; body: Blob | ArrayBuffer }[] = [];
  private busy = false;
  private failures = 0;
  private bytes = 0;
  /** Pieces left out because the queue was full (the studio unreachable for a long while). */
  dropped = 0;

  /** `limit`: the most bytes held while the studio can't be reached; beyond it new pieces are left out, so memory stays bounded. */
  constructor(
    private onChange: () => void,
    private limit = Infinity,
  ) {}

  get size(): number {
    return this.queue.length;
  }

  private sizeOf(body: Blob | ArrayBuffer): number {
    return body instanceof Blob ? body.size : body.byteLength;
  }

  add(url: string, body: Blob | ArrayBuffer, first = false): void {
    const n = this.sizeOf(body);
    if (!first && this.bytes + n > this.limit) {
      this.dropped++;
      this.onChange();
      return;
    }
    this.bytes += n;
    if (first) this.queue.unshift({ url, body });
    else this.queue.push({ url, body });
    this.onChange();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const item = this.queue[0];
      try {
        // Not keepalive: the browser allows those only 64 KB in flight, and the page's unload sends what's left (watchUnload).
        const res = await fetch(item.url, { method: 'POST', body: item.body, headers: { 'Content-Type': 'text/plain' }, credentials: 'omit' });
        await res.arrayBuffer().catch(() => undefined);
        // 409: the session ended; nothing more can be added.
        if (!res.ok && res.status !== 409 && res.status !== 404) throw new Error(String(res.status));
        this.queue.splice(this.queue.indexOf(item), 1);
        this.bytes -= this.sizeOf(item.body);
        this.failures = 0;
        this.onChange();
      } catch {
        this.failures++;
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** this.failures)));
      }
    }
    this.busy = false;
  }

  /** Resolves once everything queued has gone out (or after `ms`). */
  async drain(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (this.queue.length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }
}

export class SessionClient {
  state: ClientState = { ...initialState };
  private mic: MicStream | null = null;
  private screen: ScreenCapture | null = null;
  // At most ~35 minutes of narration and ~10 of video held while the studio can't be reached.
  private audio = new OrderedUploads(() => this.backlog(), 64e6);
  private video = new OrderedUploads(() => this.backlog(), 96e6);
  private es: EventSource | null = null;
  private endpoint = '';
  /** What lets this page write to the session and follow it (from the studio when it started). */
  private key = '';
  private listeners = new Set<(s: ClientState) => void>();
  private periodic: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;
  /** The page already listens to the studio's event stream and passes session events in (see handle). */
  private external = false;

  /** Don't open a second event stream: the caller forwards 'session' events to handle(). */
  useExternalEvents(): void {
    this.external = true;
  }

  subscribe(fn: (s: ClientState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  private backlog(): void {
    const backlog = this.audio.size + this.video.size;
    const lost = this.audio.dropped + this.video.dropped;
    if (backlog !== this.state.backlog || lost !== (this.state.lost ?? 0)) this.set({ backlog, lost });
  }

  /** A route of this session, with the key that lets this page use it. */
  private url(path: string, params: Record<string, string | number> = {}): string {
    const q = new URLSearchParams(Object.entries({ ...params, ...(this.key ? { k: this.key } : {}) }).map(([k, v]) => [k, String(v)])).toString();
    return `${this.endpoint}/api/sessions/${encodeURIComponent(this.state.id ?? '')}${path}${q ? `?${q}` : ''}`;
  }

  /** Follow a session that is already running (started elsewhere or before a reload). */
  attach(endpoint: string, id: string, startedAt: number, key = ''): void {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.key = key;
    this.set({ ...initialState, id, status: 'recording', startedAt });
    this.restorePending();
    this.listen();
    this.watchUnload();
  }

  /** After a reload: reopen the microphone (no prompt once allowed). The screen needs a click: see resumeScreen. */
  async resumeMic(deviceId?: string | null): Promise<void> {
    if (this.mic || this.state.status !== 'recording') return;
    const mic = this.makeMic();
    this.set({ mic: 'starting' });
    try {
      await mic.start(deviceId);
      this.mic = mic;
      this.set({ mic: 'on' });
    } catch (err) {
      this.set({ mic: (err as Error)?.name === 'NotAllowedError' ? 'denied' : 'error' });
    }
  }

  /** Share the screen again (must be called from a click). */
  async resumeScreen(opts: { crop?: Element | null; video: boolean }): Promise<void> {
    if (this.screen || this.state.status !== 'recording') return;
    const screen = this.makeScreen();
    try {
      await screen.start({ crop: opts.crop });
      screen.record(opts.video);
      screen.onEnded = () => this.set({ screen: 'off' });
      this.screen = screen;
      this.set({ screen: 'on' });
    } catch {
      this.set({ screen: 'denied' });
    }
  }

  private makeMic(): MicStream {
    return new MicStream(
      (c) => this.state.id && this.audio.add(this.url('/audio', { t: c.t }), c.pcm.buffer.slice(c.pcm.byteOffset, c.pcm.byteOffset + c.pcm.byteLength) as ArrayBuffer),
      () => this.moment('speech'),
    );
  }

  private videoChunks = 0;

  private makeScreen(): ScreenCapture {
    return new ScreenCapture(
      (chunk, mime, startedAt) => this.state.id && this.video.add(this.url('/video', { mime, startedAt, n: this.videoChunks++ }), chunk),
      (shot) => this.uploadShot(shot.t, shot.reason, shot.jpeg, shot.w, shot.h),
    );
  }

  private unloadHooked = false;

  /**
   * The page is going away mid-session (a reload, a link to another page):
   * send the narration still queued. What the browser won't send while
   * unloading (it limits that to 64 KB) is kept in the tab and sent first
   * when the page is back (see restorePending).
   */
  private watchUnload(): void {
    if (this.unloadHooked) return;
    this.unloadHooked = true;
    addEventListener('pagehide', () => {
      if (this.state.status !== 'recording') return;
      this.mic?.flush();
      const left: { url: string; b64: string }[] = [];
      let budget = 3_000_000;
      for (const item of this.audio.queue) {
        if (!left.length) {
          try {
            if (navigator.sendBeacon(item.url, new Blob([item.body], { type: 'text/plain' }))) continue;
          } catch {
            /* keep it below */
          }
        }
        if (item.body instanceof Blob || item.body.byteLength > budget) continue;
        budget -= item.body.byteLength;
        left.push({ url: item.url, b64: toBase64(item.body) });
      }
      try {
        if (left.length) sessionStorage.setItem(PENDING_AUDIO, JSON.stringify({ id: this.state.id, items: left }));
      } catch {
        /* storage full: nothing more can be done while the page unloads */
      }
    });
  }

  /** Narration a reload interrupted: it goes out before anything recorded since. */
  private restorePending(): void {
    let saved: { id?: string; items?: { url: string; b64: string }[] } | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(PENDING_AUDIO) ?? 'null');
      sessionStorage.removeItem(PENDING_AUDIO);
    } catch {
      return;
    }
    if (!saved?.items || saved.id !== this.state.id) return;
    for (const item of saved.items.reverse()) this.audio.add(item.url, fromBase64(item.b64), true);
  }

  private go = false;
  private cancelled = false;
  private wake: (() => void) | null = null;

  /** While counting down: record now, without waiting for the rest of the count or for what isn't ready. */
  startNow(): void {
    if (this.state.status !== 'starting') return;
    this.go = true;
    this.wake?.();
  }

  /** While starting (asking to share the screen, counting down): don't record after all. The microphone and the screen are let go. */
  cancelStart(): void {
    if (this.state.status !== 'starting' || this.state.id) return;
    this.cancelled = true;
    this.wake?.();
  }

  /** Whether this session is still on its way to recording (not stopped while the app's recorder was being started). */
  private stillStarting(id: string): boolean {
    return this.state.status === 'starting' && this.state.id === id;
  }

  /** Wait for `p`, for at most `ms`, and only while the start isn't cancelled. */
  private async waitFor(p: Promise<unknown>, ms: number): Promise<'done' | 'failed' | 'timeout' | 'cancelled'> {
    const settled = p.then(
      () => 'done' as const,
      () => 'failed' as const,
    );
    const until = Date.now() + ms;
    for (;;) {
      if (this.cancelled) return 'cancelled';
      const left = until - Date.now();
      if (left <= 0) return 'timeout';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        settled,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), left);
          this.wake = () => resolve(null);
        }),
      ]);
      clearTimeout(timer);
      this.wake = null;
      if (r) return r;
    }
  }

  /** Have the studio load the speech model narration in this language uses; resolves once it has (or can't). */
  private async warmSpeech(lang: NarrationLang): Promise<Countdown['speech']> {
    try {
      const res = await fetch(`${this.endpoint}/api/speech/warm?mode=${lang}&wait=1`, { method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(90_000) });
      const data = (await res.json()) as { narration?: string };
      return data.narration === 'live' ? 'ok' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  /** The start ends here: cancelled (`error` null: back to how it was), or given up for `error`, which is thrown for the caller to show. */
  private async notStarted(error: string | null): Promise<null> {
    await this.release();
    if (error === null) {
      this.set({ ...initialState });
      return null;
    }
    this.set({ status: 'failed', countdown: null, mic: 'off', error });
    throw new Error(error);
  }

  /** Let go of what was opened for a session that didn't start (a device that never says it stopped isn't waited for long). */
  private async release(): Promise<void> {
    const mic = this.mic;
    const screen = this.screen;
    this.mic = null;
    this.screen = null;
    await Promise.race([Promise.all([mic?.stop(), screen?.stop()].map((p) => p?.catch(() => undefined))), new Promise((r) => setTimeout(r, 4000))]);
  }

  /**
   * Start a session. The screen is asked for first (the picker needs the click
   * that started this), then the microphone opens; with a countdown, recording
   * starts once it is over and the microphone is heard, the speech model has
   * loaded and the app is there. Resolves with the session's id, or null when
   * it was cancelled; throws why it couldn't start (also kept in `error`).
   */
  async start(opts: StartOptions): Promise<string | null> {
    if (this.state.status === 'recording' || this.state.status === 'starting' || this.state.status === 'stopping') throw new Error('Already recording');
    this.endpoint = opts.endpoint.replace(/\/$/, '');
    this.go = false;
    this.cancelled = false;
    const total = Math.max(0, Math.round(opts.countdown ?? 0));
    const first: Countdown = { left: total, total, mic: opts.mic ? 'opening' : 'off', screen: 'off', speech: opts.mic ? 'loading' : 'off', app: 'ok', waiting: null, goLabel: 'Start now' };
    this.set({ ...initialState, status: 'starting', countdown: total ? first : null });
    let screenErr: 'denied' | 'unsupported' | null = null;
    if (opts.screen) {
      if (!navigator.mediaDevices?.getDisplayMedia) screenErr = 'unsupported';
      else {
        const screen = this.makeScreen();
        const asked = screen.start({ crop: opts.crop });
        // The browser's question can go unanswered, or never be asked: starting doesn't wait on it forever.
        const answer = await this.waitFor(asked, SCREEN_WAIT_MS);
        if (answer === 'done') {
          screen.onEnded = () => this.set({ screen: 'off' });
          this.screen = screen;
        } else {
          // A share allowed after all this is let go at once.
          void asked.then(
            () => screen.stop(),
            () => screen.stop(),
          );
          if (answer === 'failed') screenErr = 'denied';
          else if (answer === 'cancelled') return this.notStarted(null);
          else return this.notStarted(`Sharing the screen didn’t start within ${SCREEN_WAIT_MS / 1000} seconds. Start again, or turn off “Record the screen”.`);
        }
      }
    }
    // The microphone opens now, so it is heard before recording starts (what it hears until then isn't kept).
    let micErr: 'blocked' | 'failed' | null = null;
    let micOpen = false;
    const mic = opts.mic ? this.makeMic() : null;
    if (mic) {
      this.mic = mic;
      this.set({ mic: 'starting' });
      mic.start(opts.micDeviceId).then(
        () => {
          micOpen = true;
          if (this.mic === mic) this.set({ mic: 'on' });
          this.wake?.();
        },
        (err) => {
          micErr = (err as Error)?.name === 'NotAllowedError' ? 'blocked' : 'failed';
          if (this.mic === mic) {
            this.mic = null;
            this.set({ mic: micErr === 'blocked' ? 'denied' : 'error' });
          }
          this.wake?.();
        },
      );
    }
    let speech: Countdown['speech'] = opts.mic ? 'loading' : 'off';
    if (opts.mic && total)
      void this.warmSpeech(opts.lang).then((s) => {
        speech = s;
        this.wake?.();
      });

    if (total) {
      const endAt = Date.now() + total * 1000;
      const check = (): Countdown => {
        const m: Countdown['mic'] = !mic ? 'off' : (micErr ?? (!micOpen ? 'opening' : mic.lastSound > mic.startedAt ? 'ok' : Date.now() - mic.startedAt > 1500 ? 'quiet' : 'checking'));
        const app = !opts.appReady || opts.appReady() ? 'ok' : 'waiting';
        const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        const waiting =
          left > 0
            ? null
            : m === 'opening'
              ? 'Allow the microphone in your browser…'
              : m === 'checking'
                ? 'Listening to the microphone…'
                : m === 'quiet'
                  ? 'No sound from the microphone: check it isn’t muted.'
                  : m === 'blocked'
                    ? 'The microphone is blocked: allow it from the address bar, or record without your voice.'
                    : m === 'failed'
                      ? 'The microphone couldn’t be opened: is one connected?'
                      : app === 'waiting'
                        ? 'Waiting for your app to connect…'
                        : speech === 'loading'
                          ? 'Loading the speech model…'
                          : null;
        const goLabel = m === 'opening' || m === 'blocked' || m === 'failed' ? 'Record without voice' : waiting ? 'Start anyway' : 'Start now';
        return { left, total, mic: m, screen: !opts.screen ? 'off' : this.screen ? 'ok' : (screenErr ?? 'denied'), speech, app, waiting, goLabel };
      };
      for (;;) {
        const c = check();
        this.set({ countdown: c });
        if (this.cancelled) return this.notStarted(null);
        if (this.go || (c.left === 0 && !c.waiting)) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 200);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.wake = null;
      }
    }

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: opts.name, appUrl: opts.appUrl, source: opts.source, lang: opts.lang, replace: opts.replace }),
        credentials: 'omit',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      await this.release();
      this.set({ status: 'failed', countdown: null, mic: 'off', error: 'The studio isn’t reachable. Is `npm run dev` running?' });
      throw new Error(this.state.error!);
    }
    const data = (await res.json().catch(() => ({}))) as { session?: { id: string; startedAt: number }; key?: string; error?: string; code?: string };
    if (!res.ok || !data.session) {
      await this.release();
      this.set({ status: 'failed', countdown: null, mic: 'off', error: data.error ?? `Couldn’t start (${res.status})`, busy: data.code === 'busy' });
      throw new Error(this.state.error!);
    }
    const id = data.session.id;
    if (this.cancelled) {
      // Cancelled while the studio was creating it: it ends at once, empty.
      void fetch(`${this.endpoint}/api/sessions/${encodeURIComponent(id)}/stop${data.key ? `?k=${encodeURIComponent(data.key)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}', credentials: 'omit' }).catch(() => undefined);
      return this.notStarted(null);
    }
    this.key = data.key ?? '';
    // Recording starts now: narration from here on, and the screen's video.
    this.mic?.discard();
    this.set({ id, countdown: null });
    this.screen?.record(opts.video);
    // "Recording" shows only once the app's recorder is on (it may confirm from a frame, in a few milliseconds).
    try {
      await opts.onCreated?.(id, this.key);
    } catch (err) {
      console.warn('[saywright] starting the app’s recorder:', err);
    }
    // Stopped meanwhile (Stop works from the moment it was created).
    if (!this.stillStarting(id)) return id;
    this.set({ status: 'recording', startedAt: data.session.startedAt, screen: this.screen ? 'on' : screenErr === 'unsupported' ? 'unsupported' : screenErr ? 'denied' : 'off' });
    this.listen();
    this.watchUnload();
    this.moment('start', true);
    // A picture every 20 s of quiet, so the report always has context.
    this.periodic = setInterval(() => {
      if (Date.now() - this.lastActivity > 20_000) this.moment('periodic');
    }, 5000);
    return id;
  }

  /** Something worth a picture happened (navigation, error, a click, speech…). */
  moment(reason: string, force = false): void {
    this.lastActivity = Date.now();
    if (!this.screen || this.state.status !== 'recording' || this.state.paused) return;
    // A moment later, so the picture shows the result.
    setTimeout(() => this.screen?.shoot(reason, force), reason === 'speech' || reason === 'start' ? 0 : 450);
  }

  private uploadShot(t: number, reason: string, jpeg: Blob, w: number, h: number): void {
    if (!this.state.id) return;
    void fetch(this.url('/shots', { t, reason, w, h }), { method: 'POST', body: jpeg, headers: { 'Content-Type': 'text/plain' }, credentials: 'omit' })
      .then((res) => res.arrayBuffer())
      .catch(() => undefined);
  }

  async mark(note = '', via = 'button'): Promise<void> {
    if (!this.state.id || this.state.status !== 'recording') return;
    this.moment('mark', true);
    await fetch(this.url('/mark'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note, via, t: Date.now() }), credentials: 'omit' }).catch(() => undefined);
  }

  setPaused(paused: boolean): void {
    this.mic?.setPaused(paused);
    this.set({ paused });
  }

  get micLevel(): number {
    return this.mic?.level ?? 0;
  }

  /**
   * Is my voice getting through? From the microphone (sound at all, speech
   * now) and the studio (each sentence coming back as text).
   */
  voiceStatus(now = Date.now()): VoiceStatus {
    const s = this.state;
    const mic = this.mic;
    if (s.mic === 'denied') return { state: 'blocked', text: 'Mic blocked', hint: 'The browser blocked the microphone: allow it from the icon in the address bar.', tone: 'bad' };
    if (s.mic === 'error') return { state: 'unavailable', text: 'No microphone', hint: 'The microphone couldn’t be opened: none is connected, or another app is using it.', tone: 'bad' };
    if (s.mic === 'starting') return { state: 'starting', text: 'Starting the mic…', hint: 'Opening the microphone.', tone: 'quiet' };
    if (s.mic !== 'on' || !mic) return { state: 'off', text: 'Voice off', hint: 'Your voice isn’t being recorded in this session.', tone: 'quiet' };
    if (s.paused) return { state: 'paused', text: 'Paused', hint: 'Your voice isn’t being recorded until you resume.', tone: 'quiet' };
    if (now - mic.lastVoice < 450) return { state: 'speaking', text: 'Hearing you', hint: 'Your voice is coming through.', tone: 'ok' };
    const heard = s.heardAt ?? 0;
    if (heard && heard >= mic.lastVoice - 500 && now - heard < 2500) return { state: 'heard', text: 'Got it', hint: 'Your last sentence was transcribed: it shows next to this.', tone: 'ok' };
    if (now - Math.max(mic.lastSound, mic.startedAt) > 3000)
      return { state: 'silent', text: 'No sound from the mic', hint: 'The microphone sends silence: check it isn’t muted (a switch or key on it), or pick another one in the studio’s Settings → Voice.', tone: 'warn' };
    const sinceVoice = now - mic.lastVoice;
    if (s.narration === 'off') return { state: 'untranscribed', text: 'Recording, not transcribing', hint: 'Your voice is recorded, but the studio can’t transcribe it on this computer: install a speech model in Settings → Voice, then transcribe it from the report.', tone: 'warn' };
    if (s.narration === 'loading' && mic.lastVoice > mic.startedAt) return { state: 'loading', text: 'Loading the speech model…', hint: 'What you say is kept and transcribed as soon as the model has loaded.', tone: 'quiet' };
    if (mic.lastVoice > heard && sinceVoice < 8000) return { state: 'transcribing', text: 'Writing it down…', hint: 'Transcribing what you just said.', tone: 'quiet' };
    return { state: 'listening', text: 'Listening', hint: 'Say what you notice; each sentence appears here once it is transcribed.', tone: 'quiet' };
  }

  /** Stop recording; resolves once everything captured has reached the studio. */
  async stop(): Promise<void> {
    if (this.state.status === 'starting' && !this.state.id) return this.cancelStart();
    if (!this.state.id || (this.state.status !== 'recording' && this.state.status !== 'starting')) return;
    // The session ends now, not once the last uploads are through.
    const endedAt = Date.now();
    this.set({ status: 'stopping' });
    if (this.periodic) clearInterval(this.periodic);
    this.periodic = null;
    this.screen?.shoot('end', true);
    await new Promise((r) => setTimeout(r, 150));
    // A device that never confirms it stopped mustn't hold the session open.
    const settle = (p: Promise<unknown> | undefined) => Promise.race([p?.catch(() => undefined), new Promise((r) => setTimeout(r, 4000))]);
    await settle(this.mic?.stop());
    this.mic = null;
    await settle(this.screen?.stop());
    this.screen = null;
    await Promise.all([this.audio.drain(15_000), this.video.drain(15_000)]);
    for (let attempt = 0; ; attempt++) {
      try {
        await fetch(this.url('/stop'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ endedAt }), credentials: 'omit', signal: AbortSignal.timeout(15_000) });
        this.set({ status: 'processing', stage: 'Finishing the transcript', mic: 'off', screen: 'off' });
        return;
      } catch {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
        else return this.set({ status: 'failed', error: 'Couldn’t reach the studio to stop the session.', mic: 'off', screen: 'off' });
      }
    }
  }

  /** The session was stopped elsewhere (the studio, or the app's tab). */
  private stoppedElsewhere(): void {
    if (this.periodic) clearInterval(this.periodic);
    this.periodic = null;
    void this.mic?.stop();
    this.mic = null;
    void this.screen?.stop();
    this.screen = null;
  }

  private listen(): void {
    if (this.external) return;
    this.es?.close();
    const es = new EventSource(this.url('/live'));
    this.es = es;
    es.addEventListener('session', (e) => {
      try {
        this.handle(JSON.parse((e as MessageEvent).data));
      } catch {
        /* malformed frame */
      }
    });
  }

  /** A live update about a session from the studio's event stream. */
  handle(m: { kind: string; id: string; [k: string]: unknown }): void {
    if (!m || m.id !== this.state.id) return;
    if (m.kind === 'counts') this.set({ counts: { ...ZERO, ...(m.counts as Partial<LiveCounts>) }, audioSeconds: Number(m.audioSeconds ?? 0), ...(m.narration ? { narration: m.narration as NarrationState } : {}) });
    else if (m.kind === 'speech') {
      const seg = m.segment as { start: number; text: string };
      this.set({ captions: [...this.state.captions, { t: seg.start, text: seg.text }].slice(-3), heardAt: Date.now() });
    } else if (m.kind === 'issue') {
      this.set({ lastIssue: { t: Number(m.t), text: String(m.text) } });
      this.moment('issue');
    } else if (m.kind === 'status') {
      const status = m.status as ClientState['status'];
      if (status === 'processing' && (this.state.status === 'recording' || this.state.status === 'stopping')) this.stoppedElsewhere();
      if (status === 'processing' || status === 'ready' || status === 'failed') this.set({ status, stage: String(m.stage ?? ''), error: (m.error as string) ?? null });
      if ((status === 'ready' || status === 'failed') && this.es) {
        this.es.close();
        this.es = null;
      }
    }
  }

  reset(): void {
    this.es?.close();
    this.es = null;
    this.set({ ...initialState });
  }
}
