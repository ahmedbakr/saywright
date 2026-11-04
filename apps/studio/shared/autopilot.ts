/** Autopilot's steps, as the studio and its server both describe them (see server/autopilot.ts). */
import { isSecretHint, looksSecret, maskSecrets, MASK, type PageSnapshot } from '@saywright/vite/protocol';

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

/** Controls whose names say they delete, pay, send or sign out, in English and Arabic: Autopilot leaves them alone unless allowed. */
const RISKY =
  /\b(delete|remove account|destroy|erase|deactivate|close (?:my )?account|log ?out|sign ?out|unsubscribe|pay|purchase|buy now|place (?:the |my )?order|confirm (?:order|payment|purchase)|send|transfer|withdraw|publish|deploy|reset all)\b|حذف|احذف|إلغاء الاشتراك|تسجيل الخروج|خروج|ادفع|دفع|شراء|اشتر|إرسال|أرسل|تحويل|نشر/i;

export const isRisky = (name: string): boolean => RISKY.test(name);

/**
 * Whether Autopilot must leave a step alone unless allowed: a control whose name is risky, or Enter in a field that
 * sends its form with one ("Pay $45.45 and subscribe"), which is the same as pressing that button.
 */
export function notAllowed(action: AutopilotAction, control: { name: string; submits?: string } | undefined, allowRisky: boolean): boolean {
  if (allowRisky || !control) return false;
  if (isRisky(control.name)) return true;
  return action.kind === 'press' && (action.value || 'Enter') === 'Enter' && !!control.submits && isRisky(control.submits);
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
