/**
 * Message protocol between the Saywright studio (parent window) and the
 * bridge running inside the target app (iframe). Both sides check `ns` and the
 * message source before trusting anything.
 */

export * from './redact';
export * from './risk';

export const NS = 'saywright' as const;
/**
 * The plugin in an app and the studio are updated separately, so each side
 * says which version of this protocol it speaks (`v`, in hello and ready) and
 * the oldest of the other side's it still works with (`oldest`). Raise
 * PROTOCOL_VERSION when a message changes in a way an older side can't follow,
 * and OLDEST_PROTOCOL when this side stops understanding an older one; adding
 * a message or an optional field needs neither (unknown ones are ignored).
 */
export const PROTOCOL_VERSION = 1;
export const OLDEST_PROTOCOL = 1;

/** Which side has to be updated for a studio and an app's bridge to work together: the app's plugin, the studio, or neither. */
export function outdated(studio: { v: number; oldest?: number }, bridge: { v: number; oldest?: number }): 'plugin' | 'studio' | null {
  if (bridge.v < (studio.oldest ?? studio.v)) return 'plugin';
  if (studio.v < (bridge.oldest ?? bridge.v)) return 'studio';
  return null;
}

/** Where the studio runs unless told otherwise. Not 5173: that is Vite's own default, where your app likely runs. */
export const STUDIO_PORT = 7357;
/**
 * Through the studio's proxy, a page's XMLHttpRequest to another port of this computer says with this header that it
 * was sent with its credentials (withCredentials, set after open): the proxy then sends the site's cookies with it.
 */
export const PROXY_CREDENTIALS_HEADER = 'x-saywright-credentials';
export const STUDIO_URL = `http://localhost:${STUDIO_PORT}`;

/** Attribute names injected by the Vite plugin at compile time. */
export const SRC_ATTR = 'data-ds-src';
export const NAME_ATTR = 'data-ds-name';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the studio needs to know about an element in the app. Coordinates are iframe viewport CSS px. */
export interface ElementInfo {
  /** Runtime id, stable while the DOM node stays connected. */
  id: number;
  /** "src/components/CouponField.tsx:18:9" relative to the app root, or null for unannotated nodes. */
  src: string | null;
  /** Component name for component instances ("Button"), otherwise the tag ("div"). */
  name: string;
  tag: string;
  /** Short human label, e.g. "Button · Apply". */
  label: string;
  /** Visible text, whitespace-collapsed, at most 80 characters. */
  text: string;
  role: string | null;
  rect: Rect;
  /** Index of this node among elements sharing the same `src` (lists render one JSX site many times). */
  index: number;
  /** How many elements on the page share its `src`, when more than one: a list's rows, a component's uses. An edit to it changes them all. */
  same?: number;
  /** When `src` is null: what can find the element in the code. */
  hint?: SourceHint;
  /** Pages without source attributes: where React's development build says it came from (see SourceFrame). */
  frames?: SourceFrame[];
}

/**
 * A place React's development build gives for an element: its own JSX first, then where each component around it
 * was used. The studio's server maps them to source, skipping those in libraries.
 */
export interface SourceFrame {
  /** As the page reports it: a file, or a module or bundle address and position to map ("http://…/chunk.js:3:120"). */
  at: string;
  /** What is written there: the element's tag for its own JSX, else the component ("Button"). */
  name?: string;
  /** React 19.0 says where a component is, not where its JSX is: `at` is a place inside the component that wrote `name`. */
  inside?: boolean;
  /** The element is this component's outermost element and gets the props set where it is used: an instance site. */
  root?: boolean;
}

/** What identifies an element in its code, for pages that don't say where it was written. */
export interface SourceHint {
  /** Telling attributes as the page has them: id, data-testid, name, aria-label, href, the first classes… */
  attrs: Record<string, string>;
  /** The component file a framework's development build names (Vue), absolute or relative to the app. */
  file?: string;
}

export interface LocatorInfo {
  /** Playwright locator expression, e.g. `page.getByTestId('summary-total')`. */
  code: string;
  /** Plain words for the recorder list, e.g. `the "Apply" button`. */
  description: string;
  /** Current visible text of the element. */
  text: string;
  /** The title of the card or row that tells it apart from others like it ("Celadon mug, 12 oz"). */
  within?: string;
}

/**
 * A step of Write test, as the app's bridge saw it. A secret (a password, a card number…) comes as `secret`, the
 * name a test reads it under (PASSWORD), with an empty `value`: what was typed never leaves the page. A choice in a
 * list comes as a `fill` with `select`, the options chosen (by what they say, and `values` by their value), so a
 * studio that doesn't know `select` still writes a step rather than leaving one out. `byValue`: another option of the
 * list says the same as one chosen, so the options are chosen by their values.
 */
export type RecordedAction =
  /** `count` 2: a double click; `button` 'right': a right click (what opens a context menu). */
  | { kind: 'click'; locator: string; description: string; count?: 2; button?: 'right' }
  | { kind: 'fill'; locator: string; value: string; description: string; secret?: string; select?: string[]; values?: string[]; byValue?: boolean; checked?: boolean }
  /** A key in a field (`locator`), or on the page (no locator): an app's shortcut, Control+k, Shift+Enter. */
  | { kind: 'press'; locator?: string; key: string; description: string }
  /** The pointer rested on a part that showed what is clicked next (a menu that opens on hover). */
  | { kind: 'hover'; locator: string; description: string }
  /** An HTML drag and drop: `locator` dragged onto `to`. */
  | { kind: 'drag'; locator: string; to: string; description: string }
  /** Files chosen in a file input: their names and types only, never what is in them. */
  | { kind: 'upload'; locator: string; files: { name: string; mimeType: string }[]; description: string }
  /** Something done that a test can't do again (inside an embedded frame, a shape drawn on a canvas): said, not left out. */
  | { kind: 'missed'; description: string }
  /**
   * A dialog of the browser (alert, confirm, prompt) the step just recorded opened, and how the person answered it:
   * OK (`accept`) or Cancel, and what they typed into a prompt. A test answers it the same way.
   */
  | { kind: 'dialog'; dialog: StepDialog };

/** How a dialog a step opens is answered: OK or Cancel, and what was typed into a prompt. */
export interface StepDialog {
  type: 'alert' | 'confirm' | 'prompt';
  accept: boolean;
  /** What a prompt was answered with (OK). */
  text?: string;
  /** What the dialog said. */
  message?: string;
}

/** An element as a test session remembers it. Cheap fields are read at once; `locator`, `description` and `path` when the browser is idle. */
export interface SessionTarget {
  /** "src/components/CouponField.tsx:18:9", from the Vite plugin or React's dev info; null when unknown. */
  src: string | null;
  /** Component name ("Button") or tag ("div"). */
  name: string;
  tag: string;
  role: string | null;
  /** What a person would call it: its label, placeholder or text (≤ 60 characters). */
  label: string;
  /** Visible text (≤ 80 characters). */
  text: string;
  testId?: string;
  /** Playwright locator, e.g. page.getByRole('button', { name: 'Apply' }). */
  locator?: string;
  /** Plain words, e.g. the “Apply” button. */
  description?: string;
  /** The title of the card or row that tells it apart from others like it ("Celadon mug, 12 oz"). */
  within?: string;
  /** When the locator goes by the element's place in the code (sessions recorded before locators stopped doing so): what it is made of (see shapeOf), to find it again once that place moves. */
  shape?: string;
  /** React components from the page down to this element, e.g. "Checkout › CouponField › Button". */
  path?: string;
  /** Viewport box: x, y, width, height (CSS px). */
  rect: [number, number, number, number];
  /** A link inside running text (exempt from minimum target sizes). */
  inline?: boolean;
  /** Smaller than 24×24 px but with nothing else to click within 12 px of its centre (WCAG 2.5.8's spacing exception). */
  spaced?: boolean;
  /** When `src` is null: what can find it in the code. */
  hint?: SourceHint;
}

/**
 * Everything a test session records about the app, one event at a time. `t` is
 * wall-clock time in ms (Date.now() scale) so events from the app, the studio
 * and the microphone line up; `seq` counts events within one page load (`page`).
 */
export type SessionEventBody =
  /**
   * `state`: at the start of a session (not a page load during it), a fingerprint of the app's saved data (the keys
   * and values of localStorage and sessionStorage, the names of its cookies, hashed: none of them is kept), so a
   * replay can tell whether it started from the same data. `status`: the HTTP status the page itself was answered
   * with, where the browser tells it (a form posted and answered 500).
   */
  | { type: 'page'; url: string; title: string; referrer: string; viewport: [number, number, number]; ua: string; lang: string; reload: boolean; timing?: { ttfb: number; dcl: number; load: number }; state?: string; status?: number }
  /** `disabled`: the press landed on a disabled control, which ignores it. */
  | { type: 'click'; x: number; y: number; button: number; pointer: string; el: SessionTarget; count: number; disabled?: boolean }
  /** `masked`: a secret (`value` is a dot per character); `secret`: the name a test would read it under (PASSWORD). */
  | { type: 'input'; el: SessionTarget; value: string; masked: boolean; secret?: string }
  /**
   * `options`: what each option chosen in a list says (several, in a list that takes more than one); `value` is the
   * first. `values` and `byValue`: their values, when another option of the list says the same as one chosen.
   */
  | { type: 'change'; el: SessionTarget; value: string; checked?: boolean; options?: string[]; values?: string[]; byValue?: boolean }
  | { type: 'submit'; el: SessionTarget }
  | { type: 'key'; key: string; mods: string; el: SessionTarget | null }
  | { type: 'focus'; el: SessionTarget }
  | { type: 'nav'; url: string; title: string; how: 'push' | 'replace' | 'pop' | 'hash' }
  | { type: 'scroll'; x: number; y: number; maxY: number; el: SessionTarget | null }
  | { type: 'resize'; w: number; h: number }
  /** The pointer rested on an element for `ms`. */
  | { type: 'hover'; el: SessionTarget; ms: number }
  /** Pointer positions sampled ten times a second: [dt ms, x, y, dt, x, y, …] after `t`. */
  | { type: 'trail'; pts: number[] }
  /** `repeat`: the event stands for itself and this many more of the same message within a second (a burst after its first one). */
  | { type: 'error'; kind: 'error' | 'rejection' | 'resource'; message: string; stack?: string; source?: string; repeat?: number }
  | { type: 'console'; level: 'error' | 'warn'; text: string; stack?: string; repeat?: number }
  /**
   * `ctype`: the response's content type (a data request answered with a web page is usually a missing route). `stack`: where the request was made, when it went wrong.
   * `repeat`: the event stands for itself and this many more quick, successful requests to the same address, with the same status, within a
   * second of one recorded on its own; `ms` is their average.
   */
  /** `wants: 'data'`: the app asked for JSON (its Accept header, or an XHR's json response type). */
  | { type: 'net'; via: 'fetch' | 'xhr'; method: string; url: string; status: number; ok: boolean; ms: number; size?: number; error?: string; body?: string; ctype?: string; stack?: string; repeat?: number; wants?: 'data' }
  | { type: 'perf'; metric: 'lcp' | 'cls' | 'inp' | 'longtask' | 'fcp'; value: number; el?: SessionTarget | null; detail?: string }
  /** Several fast clicks on the same spot: the user expected something to happen. */
  | { type: 'rage'; x: number; y: number; clicks: number; el: SessionTarget }
  /** A click that changed nothing: no DOM change, navigation, request or focus within a second. */
  | { type: 'dead'; x: number; y: number; el: SessionTarget }
  | { type: 'vis'; hidden: boolean }
  /**
   * What the screen said at a key moment (start, reload, navigation, error, mark), and once it settled after an action
   * when it changed (after): the main region's text and the dialogs and messages outside it, line by line.
   */
  | { type: 'dom'; reason: string; url: string; title: string; headings: string[]; text: string }
  | { type: 'mark'; note: string; via: string }
  /** Events the page couldn't keep while the studio wasn't taking them (it holds a few thousand): how many, by type. */
  | { type: 'dropped'; count: number; kinds: Record<string, number> }
  /** Studio only: what the user pointed at with a hand or the mouse, and for how long. */
  | { type: 'point'; el: SessionTarget; ms: number; via: 'hand' | 'mouse' }
  /** Studio only: a voice or typed command, and what came of it. */
  | { type: 'command'; text: string; input: 'voice' | 'typed'; result: string }
  /** Studio only: a step Autopilot took (`did`), and why. */
  | { type: 'autopilot'; did: string; why: string }
  /** Studio only: a problem Autopilot saw, with what it expected. */
  | { type: 'observed'; severity: 'high' | 'medium' | 'low'; title: string; expected: string; actual: string; el: SessionTarget | null };

export type SessionEvent = SessionEventBody & { seq: number; t: number };

/** What the bridge posts to the studio server: events from one page load, in order. */
export interface SessionBatch {
  page: string;
  events: SessionEvent[];
}

interface Base {
  ns: typeof NS;
}

export type StudioToBridge = Base &
  (
    | { type: 'hello'; v: number; oldest?: number }
    /** Sent every animation frame while pointing. `track` lists ids whose rects should be reported. */
    | { type: 'probe'; seq: number; x: number | null; y: number | null; radius: number; deep: boolean; track: number[]; sticky?: boolean }
    | { type: 'describe'; reqId: number; id: number }
    /**
     * `check`: the locator is for a check that the element should show `expected`, so it isn't found by words the fix
     * changes; with `state`, of whether it is checked or chosen, so it is the checkbox, radio button or list it belongs
     * to (its label, an option of it, pointed at).
     */
    | { type: 'locator'; reqId: number; id: number; check?: { expected: string; state?: boolean } }
    /** Move from an element: out, in, to the next or previous one; or to the nearest one called `what` ("card"). `id` 0: from nothing. */
    | { type: 'step'; reqId: number; id: number; to: 'parent' | 'child' | 'next' | 'prev' }
    | { type: 'find'; reqId: number; id: number; what: string; where: 'any' | 'out' | 'in' }
    | { type: 'resolve'; reqId: number; src: string; index: number }
    /**
     * Replaying a session: find the element a recorded Playwright locator points at, bring it into view, and do
     * `step` on it (or nothing, just to show where it is). `read`: also answer with what it shows.
     */
    | {
        type: 'replay';
        reqId: number;
        locator: string;
        /** `select`: the options to choose, by what they say or their value (all of them, in a list that takes several). */
        /** `guard`: Autopilot acts, with “Let it delete, pay, send and sign out” off: the page refuses what would (bridge/guard.ts). */
        step?: { kind: 'click' | 'fill' | 'press'; value?: string; key?: string; checked?: boolean; select?: string[]; values?: string[]; byValue?: boolean; guard?: boolean };
        read?: boolean;
        like?: { tag: string; name: string; text: string; shape?: string };
      }
    /** Open another page of the app (same origin only), to replay a session from where it started. */
    | { type: 'goto'; url: string }
    | { type: 'click'; reqId: number; x: number; y: number }
    | { type: 'type'; reqId: number; text: string; submit: boolean }
    | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
    | { type: 'record'; on: boolean }
    /** Write test: send the steps still waiting (text being typed) now, then reply; a check said next comes after them. */
    | { type: 'flush'; reqId: number }
    /** Report the real mouse position while the user interacts with the app directly (Use / Record modes). */
    | { type: 'mouse'; on: boolean }
    /** Forward the studio's talk and cancel keys (Space outside text fields, Escape) while the app has focus. */
    | { type: 'keys'; on: boolean }
    /** Start or stop recording a test session; events go straight to `endpoint` (the studio server). */
    | { type: 'session'; on: boolean; id?: string; endpoint?: string; key?: string }
    | { type: 'mark'; note: string; via: string }
    /** Check the page for the experts asked (SEO, content, UX, accessibility); `axe`: where to load axe-core from. */
    | { type: 'review'; reqId: number; experts: ExpertId[]; axe?: string }
    /** Bring an element into view (by id, or by where it was written when the page has changed) and describe it. */
    | { type: 'reveal'; reqId: number; id: number; src: string | null; index: number }
    /** Autopilot: what the page shows and what can be done on it. */
    | { type: 'explore'; reqId: number }
  );

export type BridgeToStudio = Base &
  (
    | { type: 'ready'; v: number; oldest?: number; url: string; title: string }
    /**
     * A new page's bridge, as soon as its script runs (long before the frame's load event, which waits for every
     * image): the studio says hello at once, so a recording carries on from the page's first moments.
     */
    | { type: 'here' }
    | {
        type: 'probe';
        seq: number;
        hit: ElementInfo | null;
        snapped: boolean;
        tracked: Record<string, Rect | null>;
      }
    | {
        type: 'reply';
        reqId: number;
        ok: boolean;
        info?: ElementInfo | null;
        locator?: LocatorInfo | null;
        /** What an element shows (replay, with `read`). */
        text?: string;
        /** A state check's control: whether it is checked now. */
        checked?: boolean;
        /** A state check on an option of a list: what that option says; and what the options chosen now say. */
        option?: string;
        chosen?: string[];
        /** A page review's results. */
        review?: PageReview;
        /** What Autopilot sees of the page. */
        snapshot?: PageSnapshot;
        error?: string;
      }
    | { type: 'recorded'; action: RecordedAction }
    /** How far a long request (a page review) has got, from 0 to 1. */
    | { type: 'progress'; reqId: number; done: number }
    | { type: 'navigated'; url: string; title: string }
    | { type: 'mouse'; x: number | null; y: number | null }
    | { type: 'key'; key: 'Space' | 'Escape' | 'Mark'; down: boolean }
    /** The session recorder's state, so the studio can show it (a session can resume after a reload). */
    | { type: 'session'; id: string | null; events: number; issues: number }
    /** Something worth a screenshot just happened in the app (navigation, an error, a click…). */
    | { type: 'moment'; reason: string }
  );

/** What Autopilot sees of a page: where it is, what it says, and what can be done on it. */
export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  /** The visible text, shortened. */
  text: string;
  /** What can be clicked, filled or chosen: what is on screen first, then the rest in reading order. */
  controls: PageControl[];
  /** How many more there were than are listed. */
  more: number;
  /** An open dialog's name: only what is in it can be used until it closes. */
  dialog: string | null;
  /** The page's visible size, CSS px. */
  viewport: [number, number];
  /** The control that has the keyboard focus (its index in `controls`), where a key press goes. */
  focused?: number | null;
  /** What the page refused to do since it was last read, while Autopilot acted: “a DELETE request to /api/users/7”. */
  blocked?: string[];
}

export interface PageControl {
  /** The Playwright locator that finds it again, as the recorder writes it. */
  locator: string;
  role: string;
  /** What a person would call it: its label or its text. */
  name: string;
  /** A field: its type, what it holds now (never a password's value), whether it must be filled, its choices, and whether what is typed into it is a secret. */
  field?: { type: string; value: string; required: boolean; checked?: boolean; options?: string[]; secret?: boolean };
  /** A field in a form: what pressing Enter in it sends the form with (its default button's name, else the form's). */
  submits?: string;
  disabled: boolean;
  /** Outside what the page shows now: reached by scrolling. */
  offscreen: boolean;
  /** Where it was written ("src/components/Cart.tsx:18:9"), when known. */
  src: string | null;
  /** What the control is, beyond its name: what Autopilot judges before it uses it (see risk.ts). */
  about?: ControlAbout;
}

/** What a control is, beyond what it is called. */
export interface ControlAbout {
  /** Its title, its value, and the names of its icons (an svg `<use>` id, an icon's classes). */
  words?: string;
  /** Its own classes and variant (`btn-danger`, `destructive`). */
  classes?: string;
  /** `data-method` (a link that deletes), or `data-confirm` (the app asks first). */
  method?: string;
  confirms?: boolean;
  /** A link's address (with its secrets masked). */
  href?: string;
  /** The form a submit button sends: its address and method. */
  form?: { action: string; method: string };
  /** A control with no words of its own: what its row or card says. */
  context?: string;
  /** In a dialog that asks (`alertdialog`, or a `<dialog>` with a question): whether it is an alert, and what it says. */
  dialog?: { alert: boolean; text: string };
}

export type ExpertId = 'seo' | 'content' | 'ux' | 'a11y';
export type CheckSeverity = 'blocker' | 'high' | 'medium' | 'low' | 'info';

/** Something a page check found, with the elements it is about. */
export interface PageCheck {
  /** The rule: "SEO-16", "CNT-06", "UX-01", "axe:color-contrast". */
  rule: string;
  expert: ExpertId;
  severity: CheckSeverity;
  title: string;
  /** What was found, in words, with the numbers. */
  what: string;
  /** How to fix it. */
  fix: string;
  /** Up to six of the elements it is about. */
  els?: ElementInfo[];
  /** Their HTML, shortened. */
  html?: string[];
  /** How many there are in all (the elements are a sample). */
  count?: number;
  /** WCAG success criteria ("1.4.3"). */
  wcag?: string[];
  /** Where the rule comes from. */
  source?: string;
}

/** What a page is, for the experts and the AI: its metadata, structure and text. */
export interface PageFacts {
  url: string;
  title: string;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  lang: string | null;
  dir: string | null;
  viewport: string | null;
  headings: { level: number; text: string }[];
  og: Record<string, string>;
  jsonLd: string[];
  words: number;
  /** The main text, shortened. */
  text: string;
  links: { internal: number; external: number };
  images: number;
  /** `inputmode`: the keyboard it asks for (numeric, email…), when it says. */
  forms: { label: string; type: string; autocomplete: string | null; required: boolean; inputmode?: string | null }[];
  buttons: string[];
  /** Measured in this browser (lab, not field data). */
  lcp: number | null;
  cls: number | null;
  readability: { lang: 'en' | 'ar'; ease: number | null; grade: number | null; sentence: number } | null;
  /** The elements that matter most for a review: main headings, the first buttons and links in view, form fields. */
  elements: ElementInfo[];
  /** Landmarks as a screen reader lists them (banner, navigation, main…), with their names. */
  landmarks?: { role: string; name: string }[];
  /** Where changes are announced (role="status", "alert", aria-live…) and what each says now. */
  live?: { role: string; text: string }[];
  /** Where the links go, as written in the page (a #/route stays one). */
  linkTargets?: { text: string; href: string }[];
}

export interface PageReview {
  facts: PageFacts;
  checks: PageCheck[];
  ms: number;
}

export function isStudioMessage(data: unknown): data is { ns: typeof NS; type: string } {
  return !!data && typeof data === 'object' && (data as { ns?: unknown }).ns === NS && typeof (data as { type?: unknown }).type === 'string';
}

const JS_ESCAPES: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\u2028': '\\u2028', '\u2029': '\\u2029' };

/**
 * Text from a page as a single-quoted JavaScript string, for the locators and
 * tests Saywright writes: quotes, backslashes and every kind of line break are
 * escaped, so no text can end the string or the line it is on.
 */
export function jsString(s: string): string {
  return `'${s.replace(/[\\'\n\r\u2028\u2029]/g, (c) => JS_ESCAPES[c])}'`;
}

/** Text from a page in a `//` comment: on one line, whatever line breaks it had. */
export function jsComment(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

/** Parse "path/to/File.tsx:12:5" into parts. Paths may contain colons on Windows drive letters, so split from the right. */
export function parseSrc(src: string): { file: string; line: number; col: number } | null {
  const m = /^(.*):(\d+):(\d+)$/.exec(src);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), col: Number(m[3]) };
}
