/** Autopilot's steps, as the studio and its server both describe them (see server/autopilot.ts). */
import { dismisses, isSecretHint, looksSecret, maskSecrets, MASK, riskyPath, riskyToken, riskyWords, type PageControl, type PageSnapshot } from '@saywright/vite/protocol';

// Not yet: a drag (pointer down, move, up), which canvas apps such as drawing tools need to be used at all.
export const STEP_KINDS = ['click', 'fill', 'select', 'check', 'press', 'scroll', 'back', 'goto', 'done'] as const;
type StepKind = (typeof STEP_KINDS)[number];

export interface AutopilotAction {
  kind: StepKind;
  /** The number of the control on the page as listed (from 1). */
  control?: number;
  value?: string;
}

/** A step taken, as the next turn hears about it. */
export interface StepRecord {
  n: number;
  /** What was done: Clicked “Apply”, Typed “SAVE20” into “Coupon”, Skipped “Delete account”. */
  did: string;
  ok: boolean;
  error?: string;
  /** The page's address afterwards. */
  url: string;
  /** The page it was taken on (pageStateOf): the same step on the same page does the same again. */
  page?: string;
}

/**
 * A page as it stands, in a few characters: its address, text and controls with what they hold. Two snapshots
 * with the same one show the same thing, so a step taken on it again gives the same result.
 */
export function pageStateOf(s: PageSnapshot): string {
  const parts = [s.url, s.dialog ?? '', s.text, ...s.controls.map((c) => `${c.role}|${c.name}|${c.field ? `${c.field.value}|${c.field.checked ?? ''}` : ''}|${c.disabled}`)];
  let h = 0x811c9dc5;
  for (const ch of parts.join('\n')) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Whether a name says it deletes, pays, sends or signs out, as a whole word, in the languages the studio is used in. */
export const isRisky = (name: string): boolean => !!riskyWords(name);

type Judged = Pick<PageControl, 'name'> & Partial<Pick<PageControl, 'role' | 'submits' | 'about' | 'field'>>;

/**
 * Why Autopilot must leave a step alone unless allowed, or null. A control is judged by what it is, not only by what
 * it is called: its name, title and icons, classes that mean danger, a link's address, the address and method of
 * the form it sends, whether the app asks before it acts, and in a dialog that asks, any answer but no. Enter in a
 * field that sends its form counts as that form's button. It can't know what every control does: when a control
 * says nothing about itself, it is left alone too. (The page refuses the rest while Autopilot acts: bridge/guard.ts.)
 */
export function riskOf(action: AutopilotAction, control: Judged | undefined, pageUrl = 'http://localhost/'): string | null {
  if (action.kind === 'goto') {
    const word = riskyPath(action.value || '/', pageUrl);
    return word ? `its address says “${word}”` : null;
  }
  if (!control || (action.kind !== 'click' && action.kind !== 'press')) return null;
  // Clicking into a field to type only focuses it: a field called “Email” sends nothing.
  if (action.kind === 'click' && control.field && !['checkbox', 'radio', 'submit', 'button', 'image', 'reset'].includes(control.field.type)) return null;
  const about = control.about ?? {};
  const form = about.form;
  const formRisk = (): string | null => {
    if (!form) return null;
    if (form.method === 'delete') return 'its form sends a delete request';
    const word = riskyPath(form.action, pageUrl);
    return word ? `its form goes to an address that says “${word}”` : null;
  };
  if (action.kind === 'press') {
    if ((action.value || 'Enter') !== 'Enter' || !control.submits) return null;
    const word = riskyWords(control.submits);
    return word ? `pressing Enter sends its form with “${control.submits}”` : formRisk();
  }
  const said = riskyWords(control.name) ?? riskyWords(about.words ?? '');
  if (said) return `it says “${said}”`;
  const icon = riskyToken(about.words ?? '') ?? riskyToken(about.classes ?? '');
  if (icon) return `its icon or style says “${icon}”`;
  if (about.method === 'delete') return 'it sends a delete request';
  if (about.confirms) return 'the app asks before it does this';
  if (about.href) {
    try {
      const to = new URL(about.href, pageUrl);
      if ((to.protocol === 'http:' || to.protocol === 'https:') && to.origin !== new URL(pageUrl).origin) return 'it leaves the app for another site';
    } catch {
      /* not an address */
    }
    const word = riskyPath(about.href, pageUrl);
    if (word) return `it goes to an address that says “${word}”`;
  }
  const sent = formRisk();
  if (sent) return sent;
  if (about.dialog && !dismisses(control.name)) {
    if (about.dialog.alert) return 'it answers yes in a dialog that asks for confirmation';
    const asked = riskyWords(about.dialog.text);
    if (asked) return `it answers yes in a dialog about “${asked}”`;
  }
  if (!control.name.trim() && !about.words?.trim() && !control.field) return 'it has no name: there is no telling what it does';
  return null;
}

/** Whether Autopilot must leave a step alone unless allowed (riskOf says why). */
export function notAllowed(action: AutopilotAction, control: Judged | undefined, allowRisky: boolean, pageUrl?: string): boolean {
  return !allowRisky && !!riskOf(action, control, pageUrl);
}

/** A step in words, for the timeline and the next turn: Clicked “Apply”, Typed “SAVE20” into “Coupon”. */
export function describeStep(action: AutopilotAction, control: { name: string; role: string; field?: { secret?: boolean } } | undefined): string {
  const name = control ? `“${control.name || control.role}”` : '';
  switch (action.kind) {
    case 'click':
      return `Clicked ${name}`;
    case 'fill': {
      // What Autopilot types into a secret field (a card number, a code, a password) is never written down, as a person's isn't.
      const value = action.value ?? '';
      const secret = !!control?.field?.secret || isSecretHint(control?.name ?? '') || looksSecret(value);
      return `Typed ${secret ? MASK : `“${maskSecrets(value)}”`} into ${name}`;
    }
    case 'select':
      return `Chose “${action.value ?? ''}” in ${name}`;
    case 'check':
      return `${action.value === 'off' ? 'Unticked' : 'Ticked'} ${name}`;
    case 'press':
      return control ? `Pressed ${action.value || 'Enter'} in ${name}` : `Pressed ${action.value || 'Enter'}`;
    case 'scroll':
      return 'Scrolled down';
    case 'back':
      return 'Went back';
    case 'goto':
      return `Opened ${action.value ?? '/'}`;
    case 'done':
      return 'Finished';
  }
}
