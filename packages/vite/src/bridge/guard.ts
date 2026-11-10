/**
 * The backstop below Autopilot's judgment of a control's words (risk.ts): while Autopilot acts with “Let it delete,
 * pay, send and sign out” off, the page itself refuses what can't be taken back, whatever the control was called.
 *
 * - No `DELETE` request is sent, and no request, navigation, form or new window goes to an address whose path says it
 *   signs out, deletes, cancels, unsubscribes, pays or sends (riskyPath), or to another site.
 * - `confirm()` and `prompt()` are answered “Cancel”.
 *
 * What was refused is kept for the next look at the page (explore.ts), where Autopilot writes it down as a skipped step;
 * a refused request fails as an abort, which apps treat as nothing happened, and the session doesn't count it as an
 * error of the app. The guard is armed by each Autopilot step and stays on for a few seconds after it (what a click
 * starts can come a moment later), or until the session stops.
 */
import { redactUrl, riskyPath } from '../protocol';

/** How long after an Autopilot step the page still refuses: the app's answer to a click can take a moment. */
const ARMED_MS = 8000;
let armedUntil = 0;
let installed = false;
const blocked: string[] = [];

/** The reason an abort carries when the guard refused a request: apps treat an abort as “nothing happened”. */
export const GUARD_MESSAGE = 'Saywright’s Autopilot didn’t send this request';

const armed = (): boolean => performance.now() < armedUntil;

/** Autopilot is about to act (or the person allowed it all: `on` false disarms). */
export function arm(on: boolean): void {
  armedUntil = on ? performance.now() + ARMED_MS : 0;
  if (on) install();
}

/** Disarm: the session stopped. */
export function disarm(): void {
  armedUntil = 0;
}

/** What was refused since the last call. */
export function takeBlocked(): string[] {
  return blocked.splice(0);
}

/** Whether an error or a rejection is the guard's own refusal (the session leaves it out of the app's errors). */
export function isGuardRefusal(reason: unknown): boolean {
  return !!reason && typeof reason === 'object' && (reason as { message?: unknown }).message === GUARD_MESSAGE;
}

function note(what: string): void {
  if (blocked.length < 20 && !blocked.includes(what)) blocked.push(what);
}

/** Why a request or a page at `url` must not happen now, or null. */
function refusal(url: string, method = 'GET'): string | null {
  if (!armed()) return null;
  let u: URL;
  try {
    u = new URL(url, location.href);
  } catch {
    return null;
  }
  const where = redactUrl(u.origin === location.origin ? `${u.pathname}${u.search}` : u.href);
  if (method.toUpperCase() === 'DELETE') return `a DELETE request to ${where}`;
  if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== location.origin && method === 'NAVIGATE') return `opening ${where}, another site`;
  const word = riskyPath(u.href);
  return word ? `${method === 'NAVIGATE' ? 'opening' : `a ${method.toUpperCase()} request to`} ${where} (“${word}”)` : null;
}

const abort = (): DOMException => new DOMException(GUARD_MESSAGE, 'AbortError');

function install(): void {
  if (installed) return;
  installed = true;

  const fetch0 = window.fetch;
  if (fetch0) {
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const why = refusal(url, method);
      if (why) {
        note(why);
        return Promise.reject(abort());
      }
      return fetch0.call(this, input, init);
    } as typeof fetch;
  }

  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    meta.set(this, { method: String(method), url: String(url) });
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const m = meta.get(this);
    const why = m ? refusal(m.url, m.method) : null;
    if (why) {
      note(why);
      // As an aborted request: its handlers hear that it ended without an answer.
      setTimeout(() => {
        this.dispatchEvent(new ProgressEvent('abort'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      }, 0);
      return;
    }
    return send.call(this, body);
  };

  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      const why = refusal(String(url), 'POST');
      if (why) {
        note(why);
        return false;
      }
      return beacon(url, data);
    };
  }

  const open0 = window.open;
  window.open = function (this: Window, url?: string | URL, ...rest: unknown[]) {
    const why = url ? refusal(String(url), 'NAVIGATE') : null;
    if (why) {
      note(why);
      return null;
    }
    return (open0 as (...a: unknown[]) => Window | null).call(this, url, ...rest);
  } as typeof window.open;

  const confirm0 = window.confirm;
  window.confirm = function (message?: string) {
    if (armed()) {
      note(`“OK” in a question it was asked (“${String(message ?? '').slice(0, 80)}”): it answered “Cancel”`);
      return false;
    }
    return confirm0.call(window, message);
  };
  const prompt0 = window.prompt;
  window.prompt = function (message?: string, value?: string) {
    if (armed()) {
      note(`answering a question it was asked (“${String(message ?? '').slice(0, 80)}”): it answered “Cancel”`);
      return null;
    }
    return prompt0.call(window, message, value);
  };

  // A form sent to such an address, by its button, by Enter, or by the app's own code.
  const formRefusal = (form: HTMLFormElement, submitter?: HTMLElement | null): string | null => {
    const action = submitter?.getAttribute('formaction') || form.getAttribute('action') || location.href;
    const method = (submitter?.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase();
    const override = (form.querySelector('input[name="_method"]') as HTMLInputElement | null)?.value;
    if (override && /^delete$/i.test(override)) return refusal(new URL(action, location.href).href, 'DELETE');
    return refusal(new URL(action, location.href).href, method === 'POST' ? 'POST' : 'NAVIGATE');
  };
  addEventListener(
    'submit',
    (e) => {
      const form = e.target as HTMLFormElement;
      const why = form instanceof HTMLFormElement ? formRefusal(form, (e as SubmitEvent).submitter) : null;
      if (why) {
        note(`sending a form: ${why}`);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  const submit0 = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    const why = formRefusal(this);
    if (why) return note(`sending a form: ${why}`);
    return submit0.call(this);
  };

  // A link (the app's handler may not run for it: the browser follows it).
  addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const why = a.getAttribute('data-method')?.toLowerCase() === 'delete' ? refusal(a.href, 'DELETE') : refusal(a.href, 'NAVIGATE');
      if (why) {
        note(why);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  // Whatever else leaves the page (location.href = …, a router's full load): where the browser can still stop it.
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigate', (e) => {
    const ev = e as Event & { destination?: { url: string }; cancelable: boolean; formData?: FormData | null };
    if (!ev.destination || !ev.cancelable) return;
    const why = refusal(ev.destination.url, ev.formData ? 'POST' : 'NAVIGATE');
    if (why) {
      note(why);
      ev.preventDefault();
    }
  });
}
