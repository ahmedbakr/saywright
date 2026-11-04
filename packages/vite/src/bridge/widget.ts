/**
 * The test-session recorder inside the app's own tab (when it isn't open in
 * the studio): a small button that starts a session, then a pill with the
 * timer, the live transcript, Mark and Stop. Lives in a shadow root so the
 * app's styles and ours never mix.
 *
 *   Alt+Shift+R  start / stop      Alt+Shift+M  mark this moment      Alt+Shift+D  show / hide
 */
import { SessionClient, type ClientState, type Countdown, type NarrationLang } from '../client';
import { redactUrl } from '../protocol';
import type { SessionRecorder } from './session';

const HIDE_KEY = 'saywright.widget.hidden';
/** Which side of the page it sits on: moved out of the way of the page's own controls. */
const SIDE_KEY = 'saywright.widget.side';
const PREFS_KEY = 'saywright.widget.prefs';

interface Prefs {
  lang: NarrationLang;
  mic: boolean;
  screen: boolean;
  /** Count down 3 seconds first, checking the microphone is heard. */
  countdown: boolean;
}

const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","Noto Sans Arabic",Tahoma,sans-serif}
.root{position:fixed;z-index:2147483646;right:16px;bottom:16px;color:#ededef;font-size:13px;line-height:1.4;-webkit-font-smoothing:antialiased}
.fab{display:flex;align-items:center;gap:8px;height:36px;padding:0 14px 0 10px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(22,22,26,.88);backdrop-filter:blur(14px);box-shadow:0 8px 30px rgba(0,0,0,.35);cursor:pointer;color:inherit;font-size:12.5px;font-weight:600;transition:transform .15s ease}
.fab:hover{transform:translateY(-1px)}
.dot{width:10px;height:10px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.25)}
.panel{width:300px;padding:14px;border-radius:16px;border:1px solid rgba(255,255,255,.12);background:rgba(22,22,26,.94);backdrop-filter:blur(16px);box-shadow:0 18px 50px rgba(0,0,0,.45)}
.row{display:flex;align-items:center;gap:8px}
.title{font-weight:650;font-size:14px;flex:1}
.muted{color:#a0a0ab;font-size:12px}
input[type=text]{width:100%;height:32px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#ededef;padding:0 10px;font-size:12.5px;outline:none}
input[type=text]:focus{border-color:#0090ff}
.seg{display:flex;background:rgba(255,255,255,.06);border-radius:9px;padding:2px;gap:2px}
.seg button{flex:1;height:26px;border:0;border-radius:7px;background:transparent;color:#a0a0ab;font-size:12px;cursor:pointer}
.seg button[aria-pressed=true]{background:rgba(255,255,255,.14);color:#fff}
.check{display:flex;align-items:center;justify-content:space-between;padding:6px 0;font-size:12.5px}
.switch{width:30px;height:18px;border-radius:99px;background:rgba(255,255,255,.18);position:relative;border:0;cursor:pointer;transition:background .15s}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
.switch[aria-checked=true]{background:#0090ff}.switch[aria-checked=true]::after{transform:translateX(12px)}
.btn{height:32px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#ededef;font-size:12.5px;font-weight:600;padding:0 12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.btn:hover{background:rgba(255,255,255,.1)}
.btn.primary{background:#e5484d;border-color:#e5484d;color:#fff}.btn.primary:hover{background:#dc3e42}
.btn.blue{background:#0090ff;border-color:#0090ff;color:#fff}
.btn:disabled{opacity:.5;cursor:default}
.icon{width:28px;padding:0}
.pill{display:flex;align-items:center;gap:10px;height:40px;padding:0 6px 0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(22,22,26,.92);backdrop-filter:blur(14px);box-shadow:0 10px 34px rgba(0,0,0,.4)}
.rec{animation:pulse 1.4s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}
.time{font-variant-numeric:tabular-nums;font-weight:650;min-width:42px}
.voice{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:58px}
.bars{display:flex;align-items:center;gap:2px;height:14px}.bars i{display:block;width:3px;border-radius:2px;background:#0090ff;height:3px;transition:height .08s,background-color .1s}
.voice-text{font-size:9.5px;font-weight:600;line-height:1;white-space:nowrap;color:#a0a0ab}
.voice[data-tone=ok] .bars i{background:#3dd68c}.voice[data-tone=ok] .voice-text{color:#3dd68c}
.voice[data-tone=warn] .bars i{background:#ffc53d}.voice[data-tone=warn] .voice-text{color:#ffc53d}
.voice[data-tone=bad] .voice-text{color:#ff9592}
.count{font-size:11.5px;color:#a0a0ab;display:flex;gap:8px}.count b{color:#ededef}.count .bad b{color:#ff9592}
.root[data-side=left]{right:auto;left:16px}
.root[data-side=left] .caption{margin:0 auto 8px 0}
.mini{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1px solid rgba(255,255,255,.16);background:rgba(22,22,26,.85);box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;padding:0}
.mini .dot{width:8px;height:8px;box-shadow:0 0 0 2px rgba(229,72,77,.25)}
.caption{max-width:340px;margin:0 0 8px auto;padding:8px 12px;border-radius:12px;background:rgba(22,22,26,.9);border:1px solid rgba(255,255,255,.1);font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.3)}
.caption .issue{color:#ff9592}
.err{color:#ff9592;font-size:12px;margin-top:8px}
.kbd{font:11px ui-monospace,monospace;color:#a0a0ab;border:1px solid rgba(255,255,255,.14);border-radius:5px;padding:0 4px}
.cd-back{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);backdrop-filter:blur(3px)}
.cd{width:340px;max-width:calc(100vw - 32px);padding:20px;border-radius:18px;border:1px solid rgba(255,255,255,.12);background:rgba(22,22,26,.97);box-shadow:0 24px 70px rgba(0,0,0,.5);text-align:center}
.cd-ring{position:relative;width:110px;height:110px;margin:0 auto}
.cd-ring svg{position:absolute;inset:0;transform:rotate(-90deg)}
.cd-ring .run{animation:cd-ring var(--total) linear forwards}
.cd-ring .spin{transform-origin:50% 50%;animation:cd-spin 1.4s linear infinite}
@keyframes cd-ring{to{stroke-dashoffset:264}}@keyframes cd-spin{to{transform:rotate(360deg)}}
.cd-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:50px;font-weight:650;font-variant-numeric:tabular-nums;animation:cd-pop .35s cubic-bezier(.2,.9,.25,1)}
@keyframes cd-pop{from{transform:scale(1.5);opacity:0}}
.cd-title{margin-top:10px;font-weight:650;font-size:14px}
.cd-checks{list-style:none;margin:12px 0 0;padding:0 12px;text-align:left;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}
.cd-checks li{display:flex;justify-content:space-between;gap:10px;padding:8px 0;font-size:12.5px;border-top:1px solid rgba(255,255,255,.06)}
.cd-checks li:first-child{border-top:0}
.cd-checks span:last-child{color:#a0a0ab;text-align:right}
.cd-checks [data-tone=ok] span:last-child{color:#3dd68c}.cd-checks [data-tone=warn] span:last-child{color:#ffc53d}.cd-checks [data-tone=bad] span:last-child{color:#ff9592}
`;

const ICON = {
  flag: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4a1 1 0 0 1 1-1h12l-2 4 2 4H5"/></svg>',
  stop: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  pause: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  play: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
  close: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  side: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h12l-3-3M17 17H5l3 3"/></svg>',
  hide: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 12h12"/></svg>',
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function readPrefs(): Prefs {
  try {
    return { lang: 'auto', mic: true, screen: true, countdown: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { lang: 'auto', mic: true, screen: true, countdown: true };
  }
}

export class Widget {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private root: HTMLDivElement;
  private client = new SessionClient();
  private view: 'button' | 'setup' = 'button';
  private prefs = readPrefs();
  private name = '';
  private endpoint: string;
  private reachable: boolean | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private hidden: boolean;
  private side: 'left' | 'right';

  constructor(
    endpoint: string,
    private recorder: SessionRecorder,
  ) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.hidden = localStorage.getItem(HIDE_KEY) === '1';
    this.side = localStorage.getItem(SIDE_KEY) === 'left' ? 'left' : 'right';
    this.host = document.createElement('saywright-recorder');
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.root = document.createElement('div');
    this.root.className = 'root';
    this.shadow.append(style, this.root);
    const mount = () => document.body.appendChild(this.host);
    if (document.body) mount();
    else addEventListener('DOMContentLoaded', mount, { once: true });

    this.client.subscribe((s) => this.onState(s));
    addEventListener('keydown', this.onKey, true);
    void this.resume();
  }

  /** Recording carries on across reloads: pick up the running session. */
  private async resume(): Promise<void> {
    try {
      const res = await fetch(`${this.endpoint}/api/sessions/active`, { credentials: 'omit' });
      const data = (await res.json()) as { session: { id: string; startedAt: number; source: string } | null };
      this.reachable = true;
      if (data.session && this.recorder.id === data.session.id && this.client.state.status === 'idle') {
        this.client.attach(this.endpoint, data.session.id, data.session.startedAt, this.recorder.key);
        this.recorder.setMomentHandler((reason) => this.client.moment(reason));
        if (this.prefs.mic) void this.client.resumeMic();
      }
    } catch {
      this.reachable = false;
    }
    this.render();
  }

  private onKey = (e: KeyboardEvent): void => {
    const st = this.client.state;
    if (st.status === 'starting' && st.countdown && !st.id && (e.key === 'Escape' || e.key === 'Enter') && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') this.client.cancelStart();
      else this.client.startNow();
      return;
    }
    if (!e.altKey || !e.shiftKey) return;
    if (e.code === 'KeyR') {
      e.preventDefault();
      if (this.client.state.status === 'recording') void this.stop();
      else void this.start();
    } else if (e.code === 'KeyM') {
      e.preventDefault();
      this.mark('shortcut');
    } else if (e.code === 'KeyD') {
      e.preventDefault();
      this.setHidden(!this.hidden);
    }
  };

  private onState(s: ClientState): void {
    // The clock and the voice meter: small in-place updates (see renderLive), not a redraw.
    if (s.status === 'recording' && !this.tick) this.tick = setInterval(() => this.renderLive(), 150);
    if (s.status !== 'recording' && this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
    this.render();
  }

  /** Hidden: out of the page's way. While recording, a small dot stays, so it is never recording unseen. */
  private setHidden(on: boolean): void {
    this.hidden = on;
    localStorage.setItem(HIDE_KEY, on ? '1' : '0');
    this.shown = '';
    this.render();
  }

  private savePrefs(): void {
    localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
  }

  async start(replace = false): Promise<void> {
    if (this.client.state.status === 'recording' || this.client.state.status === 'starting') return;
    this.view = 'button';
    try {
      await this.client.start({
        replace,
        endpoint: this.endpoint,
        name: this.name || undefined,
        lang: this.prefs.lang,
        appUrl: redactUrl(location.href),
        source: 'app',
        mic: this.prefs.mic,
        screen: this.prefs.screen,
        video: this.prefs.screen,
        countdown: this.prefs.countdown ? 3 : 0,
        // The app's events from the first moment, not once the microphone is ready.
        onCreated: (id, key) => {
          this.recorder.start({ id, endpoint: this.endpoint, key });
          this.recorder.setMomentHandler((reason) => this.client.moment(reason));
        },
      });
    } catch {
      this.view = 'setup';
      this.render();
    }
  }

  async stop(): Promise<void> {
    this.recorder.stop();
    await this.client.stop();
  }

  /** One mark: the app's recorder logs it, the recording client adds the picture (it was logged twice, once by each). */
  mark(via: 'shortcut' | 'button' = 'button'): void {
    if (this.client.state.status !== 'recording') return;
    this.recorder.mark('', via);
    this.client.moment('mark', true);
  }

  // ---- rendering ----------------------------------------------------------------

  private render(): void {
    const s = this.client.state;
    const live = s.status === 'recording' || s.status === 'starting' || s.status === 'stopping';
    this.root.style.display = this.hidden && !live ? 'none' : '';
    this.root.dataset.side = this.side;
    if (s.status === 'starting' && s.countdown && !s.id) return this.renderCountdown(s.countdown);
    if (live && this.hidden) {
      this.issueUntil = 0;
      const html = `<button class="mini" data-act="show" title="Recording: show the controls (Alt+Shift+D)" aria-label="Recording: show the controls"><span class="dot ${s.paused ? '' : 'rec'}"></span></button>`;
      if (html === this.shown) return;
      this.shown = html;
      this.root.innerHTML = html;
      this.bind();
      return;
    }
    if (s.status === 'recording' || s.status === 'starting' || s.status === 'stopping') return this.renderRecording(s);
    this.shown = '';
    if (s.status === 'processing' || s.status === 'ready' || (s.status === 'failed' && s.id)) return this.renderDone(s);
    if (this.view === 'setup') return this.renderSetup(s);
    this.root.innerHTML = `<button class="fab" data-act="open" title="Record a session: use the app and talk, get a report (Alt+Shift+R)"><span class="dot"></span>Record session</button>`;
    this.bind();
  }

  private renderSetup(s: ClientState): void {
    const p = this.prefs;
    this.root.innerHTML = `<div class="panel">
      <div class="row" style="margin-bottom:10px"><div class="title">Record a session</div><button class="btn icon" data-act="close" aria-label="Close">${ICON.close}</button></div>
      <input type="text" data-field="name" placeholder="Name (optional), e.g. Checkout with a coupon" value="${esc(this.name)}">
      <div class="muted" style="margin:12px 0 6px">I’ll narrate in</div>
      <div class="seg" role="group">
        <button data-lang="en" aria-pressed="${p.lang === 'en'}">English</button>
        <button data-lang="ar" aria-pressed="${p.lang === 'ar'}">العربية</button>
        <button data-lang="auto" aria-pressed="${p.lang === 'auto'}">Both</button>
      </div>
      <div style="margin-top:10px">
        <div class="check"><span>Record my voice</span><button class="switch" role="switch" data-toggle="mic" aria-checked="${p.mic}"></button></div>
        <div class="check"><span>Record the screen</span><button class="switch" role="switch" data-toggle="screen" aria-checked="${p.screen}"></button></div>
        <div class="check"><span>Count down 3 s first</span><button class="switch" role="switch" data-toggle="countdown" aria-checked="${p.countdown}"></button></div>
      </div>
      ${this.reachable === false ? `<div class="err">The studio isn’t running at ${esc(this.endpoint)}. Start it with <b>npx @saywright/studio</b>.</div>` : ''}
      ${s.error ? `<div class="err">${esc(s.error)}${s.busy ? ` <button class="btn" style="height:24px;margin-top:6px" data-act="replace">Stop it and start mine</button>` : ''}</div>` : ''}
      <div class="row" style="margin-top:12px"><button class="btn primary" style="flex:1" data-act="start"><span class="dot" style="background:#fff;box-shadow:none;width:8px;height:8px"></span>Start recording</button></div>
      <div class="muted" style="margin-top:8px;font-size:11.5px">Use the app as usual and talk about what you notice. <span class="kbd">Alt⇧M</span> marks a moment, <span class="kbd">Alt⇧R</span> stops.</div>
    </div>`;
    this.bind();
  }

  /** The markup last written: state changes that don't change what is shown (an upload queued, say) don't touch the page. */
  private shown = '';
  private shownTime = '';
  private shownBars = '';
  private shownVoice = '';

  private renderRecording(s: ClientState): void {
    const caption = s.captions[s.captions.length - 1];
    const issue = s.lastIssue && Date.now() - s.lastIssue.t < 6000 ? s.lastIssue : null;
    const html = `
      <div class="caption" data-caption style="${caption || issue ? '' : 'display:none'}" dir="auto">${issue ? `<span class="issue">⚠ ${esc(issue.text)}</span>` : caption ? esc(caption.text) : ''}</div>
      <div class="pill">
        <span class="dot ${s.paused ? '' : 'rec'}"></span>
        <span class="time" data-time>${s.status === 'starting' ? '…' : ''}</span>
        ${s.mic === 'on' ? `<span class="voice" data-voice><span class="bars" data-bars>${'<i></i>'.repeat(5)}</span><span class="voice-text" data-voice-text></span></span>` : s.mic !== 'off' ? `<span class="voice" data-tone="${s.mic === 'starting' ? 'quiet' : 'bad'}" title="${esc(this.client.voiceStatus().hint)}"><span class="voice-text">${esc(this.client.voiceStatus().text)}</span></span>` : ''}
        <span class="count"><span><b>${s.counts.speech}</b> said</span><span class="${s.counts.errors + s.counts.failedRequests + s.counts.frustration ? 'bad' : ''}"><b>${s.counts.errors + s.counts.failedRequests + s.counts.frustration}</b> issues</span></span>
        ${this.prefs.screen && s.screen === 'off' && s.status === 'recording' ? `<button class="btn" data-act="screen" title="Screenshots stopped after the page reloaded">Share screen</button>` : ''}
        <button class="btn icon" data-act="mark" title="Mark this moment (Alt+Shift+M)">${ICON.flag}</button>
        <button class="btn icon" data-act="pause" title="${s.paused ? 'Resume narration' : 'Pause narration'}">${s.paused ? ICON.play : ICON.pause}</button>
        <button class="btn" data-act="stop" ${s.status !== 'recording' ? 'disabled' : ''}>${ICON.stop}${s.status === 'stopping' ? 'Saving…' : 'Stop'}</button>
        <button class="btn icon" data-act="side" title="Move to the other side of the page" aria-label="Move to the other side of the page">${ICON.side}</button>
        <button class="btn icon" data-act="hide" title="Hide the controls; it goes on recording (Alt+Shift+D)" aria-label="Hide the controls">${ICON.hide}</button>
      </div>`;
    // A problem shows for six seconds: come back then to take it down.
    this.issueUntil = issue ? issue.t + 6000 : 0;
    if (html === this.shown) return;
    this.shown = html;
    this.shownTime = this.shownBars = this.shownVoice = '';
    this.root.innerHTML = html;
    this.bind();
    this.renderLive();
  }

  private issueUntil = 0;

  /** Before recording: the count in the middle of the page, and what is checked meanwhile. */
  private renderCountdown(c: Countdown): void {
    const speaking = c.mic === 'ok' && this.client.voiceStatus().state === 'speaking';
    const rows: [string, string, string][] = [];
    const mic = { opening: ['Opening… allow it if asked', 'wait'], checking: ['Listening…', 'wait'], ok: [speaking ? 'Hearing you' : 'Working', 'ok'], quiet: ['No sound: is it muted?', 'warn'], blocked: ['Blocked: allow it in the address bar', 'bad'], failed: ['Couldn’t be opened', 'bad'] } as const;
    if (c.mic !== 'off') rows.push(['Microphone', ...mic[c.mic]]);
    const speech = { loading: ['Loading…', 'wait'], ok: ['Ready', 'ok'], unavailable: ['Not installed: voice kept', 'warn'] } as const;
    if (c.speech !== 'off') rows.push(['Speech model', ...speech[c.speech]]);
    const screen = { ok: ['Sharing this tab', 'ok'], denied: ['Not shared', 'warn'], unsupported: ['Not supported here', 'warn'] } as const;
    if (c.screen !== 'off') rows.push(['Screen', ...screen[c.screen]]);
    const waiting = c.left === 0;
    const R = 42;
    const C = Math.round(2 * Math.PI * R);
    const html = `<div class="cd-back" data-countdown><div class="cd" role="dialog" aria-label="Recording starts soon">
      <div class="cd-ring" style="--total:${c.total}s">
        <svg viewBox="0 0 110 110"><circle cx="55" cy="55" r="${R}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="5"/><circle class="${waiting ? 'spin' : 'run'}" cx="55" cy="55" r="${R}" fill="none" stroke="#e5484d" stroke-width="5" stroke-linecap="round" stroke-dasharray="${waiting ? `${C * 0.22} ${C}` : C}"/></svg>
        ${waiting ? '' : `<div class="cd-num" data-count="${c.left}">${c.left}</div>`}
      </div>
      <div class="cd-title">${esc(c.left > 0 ? 'Recording starts in a moment' : (c.waiting ?? 'Starting…'))}</div>
      <ul class="cd-checks">${rows.map(([k, v, tone]) => `<li data-tone="${tone}"><span>${k}</span><span>${esc(v)}</span></li>`).join('')}</ul>
      <div class="row" style="margin-top:14px"><button class="btn primary" style="flex:1" data-act="go">${esc(c.goLabel)}</button><button class="btn" data-act="cancel">Cancel</button></div>
    </div></div>`;
    if (html === this.shown) return;
    // The ring keeps running between seconds: only the parts that change are replaced.
    const ring = this.shadow.querySelector('.cd-ring');
    if (ring && this.shown.startsWith('<div class="cd-back"') && !waiting && !ring.querySelector('.spin')) {
      const num = ring.querySelector<HTMLElement>('.cd-num');
      if (num && num.dataset.count !== String(c.left)) num.replaceWith(Object.assign(document.createElement('div'), { className: 'cd-num', textContent: String(c.left) }));
      const title = this.shadow.querySelector('.cd-title');
      if (title) title.textContent = c.left > 0 ? 'Recording starts in a moment' : (c.waiting ?? 'Starting…');
      const checks = this.shadow.querySelector('.cd-checks');
      if (checks) checks.innerHTML = rows.map(([k, v, tone]) => `<li data-tone="${tone}"><span>${k}</span><span>${esc(v)}</span></li>`).join('');
      const go = this.shadow.querySelector('[data-act="go"]');
      if (go) go.textContent = c.goLabel;
      this.shown = html;
      return;
    }
    this.shown = html;
    this.root.innerHTML = html;
    this.bind();
  }

  private renderLive(): void {
    const s = this.client.state;
    if (s.status !== 'recording') return;
    if (this.issueUntil && Date.now() > this.issueUntil) return this.render();
    const t = clock(Date.now() - s.startedAt);
    if (t !== this.shownTime) {
      const time = this.shadow.querySelector('[data-time]');
      if (time) time.textContent = t;
      this.shownTime = t;
    }
    if (s.mic !== 'on') return;
    // Is the voice getting through: green while it is heard, and what happens to what was said.
    const voice = this.client.voiceStatus();
    if (voice.text + voice.tone !== this.shownVoice) {
      this.shownVoice = voice.text + voice.tone;
      const box = this.shadow.querySelector<HTMLElement>('[data-voice]');
      const text = this.shadow.querySelector('[data-voice-text]');
      if (box) {
        box.dataset.tone = voice.tone;
        box.title = voice.hint;
      }
      if (text) text.textContent = voice.text;
    }
    const level = Math.min(1, this.client.micLevel);
    const heights = [0, 1, 2, 3, 4].map((i) => Math.round(3 + Math.max(0, level * 14 - Math.abs(i - 2) * 3)));
    const key = heights.join(',');
    if (key === this.shownBars) return;
    this.shownBars = key;
    this.shadow.querySelectorAll<HTMLElement>('[data-bars] i').forEach((b, i) => (b.style.height = `${heights[i]}px`));
  }

  private renderDone(s: ClientState): void {
    const url = `${this.endpoint}/report/${encodeURIComponent(s.id ?? '')}`;
    const body =
      s.status === 'ready'
        ? `<div class="title">Report ready</div><div class="muted" style="margin:4px 0 10px">Issues, scores and suggestions from this session.</div><div class="row"><a class="btn blue" style="flex:1;text-decoration:none" href="${url}" target="_blank" rel="noopener" data-act="opened">Open the report</a><button class="btn" data-act="dismiss">Close</button></div>`
        : s.status === 'failed'
          ? `<div class="title">Couldn’t finish the report</div><div class="err">${esc(s.error ?? '')}</div><div class="row" style="margin-top:10px"><a class="btn" href="${url}" target="_blank" rel="noopener">Open in the studio</a><button class="btn" data-act="dismiss">Close</button></div>`
          : `<div class="row"><span class="dot rec" style="background:#0090ff;box-shadow:none"></span><div class="title">Preparing the report…</div></div><div class="muted" style="margin-top:6px">${esc(s.stage || 'Working')}</div>`;
    this.root.innerHTML = `<div class="panel">${body}</div>`;
    this.bind();
  }

  /** Have the studio load the speech models while the session is being set up: the first sentence isn't kept waiting. */
  private warm(): void {
    if (!this.prefs.mic || !this.endpoint) return;
    void fetch(`${this.endpoint}/api/speech/warm?mode=${this.prefs.lang}`, { method: 'POST', credentials: 'omit' }).catch(() => undefined);
  }

  private bind(): void {
    this.shadow.querySelectorAll<HTMLElement>('[data-act]').forEach((el) =>
      el.addEventListener('click', () => {
        const act = el.dataset.act;
        if (act === 'open') {
          this.view = 'setup';
          this.warm();
          void this.resume();
        } else if (act === 'close') {
          this.view = 'button';
          this.render();
        } else if (act === 'start') void this.start();
        else if (act === 'replace') void this.start(true);
        else if (act === 'stop') void this.stop();
        else if (act === 'go') this.client.startNow();
        else if (act === 'cancel') this.client.cancelStart();
        else if (act === 'mark') this.mark();
        else if (act === 'pause') this.client.setPaused(!this.client.state.paused);
        else if (act === 'screen') void this.client.resumeScreen({ video: true });
        else if (act === 'hide') this.setHidden(true);
        else if (act === 'show') this.setHidden(false);
        else if (act === 'side') {
          this.side = this.side === 'right' ? 'left' : 'right';
          localStorage.setItem(SIDE_KEY, this.side);
          this.render();
        }
        else if (act === 'dismiss' || act === 'opened') {
          this.client.reset();
          this.view = 'button';
          this.render();
        }
      }),
    );
    this.shadow.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) =>
      b.addEventListener('click', () => {
        this.prefs.lang = b.dataset.lang as NarrationLang;
        this.savePrefs();
        this.warm();
        this.render();
      }),
    );
    this.shadow.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.toggle as 'mic' | 'screen' | 'countdown';
        this.prefs[k] = !this.prefs[k];
        this.savePrefs();
        this.render();
      }),
    );
    const name = this.shadow.querySelector<HTMLInputElement>('[data-field="name"]');
    name?.addEventListener('input', () => (this.name = name.value));
    // Keep the app's own shortcuts from firing while typing a name.
    name?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.start();
    });
  }
}
