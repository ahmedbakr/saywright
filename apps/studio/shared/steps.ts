/**
 * Recorded steps as a test may hold them, the same in the studio's page and its server: a secret by its name only,
 * and a choice in a list as a choice. Steps an older plugin recorded (a password in clear, a list written as a
 * fill) are put right here, before anyone sees them.
 */
import { isSecretHint, looksSecret, MASK, maskSecrets, secretEnvName, secretName, SECRET_ENV_PREFIX } from '@saywright/vite/protocol';
import type { RecordedStep } from './api.ts';

/** A secret's name as a test reads it: capitals, digits and underscores (PASSWORD, CARD_NUMBER). */
const secretKey = (name: string) => secretEnvName(name).slice(SECRET_ENV_PREFIX.length);

/** The field a locator names, in words: `page.getByLabel('Password')` → Password. */
function fieldWords(step: RecordedStep): string {
  const quoted = Array.from((step.locator ?? '').matchAll(/'((?:[^'\\]|\\.)*)'/g), (m) => m[1]).join(' ');
  const said = /“([^”]*)”[^“]*$/.exec(step.description)?.[1] ?? '';
  return `${quoted} ${said}`;
}

/**
 * Steps as a test may hold them, whoever recorded them: a value typed into a field called like a secret (an older
 * plugin's “Type “hunter2” into the “Password” field”), or one that looks like a key or a card number, becomes a
 * secret by name with no value, and its description loses the value; a choice in a list an older plugin wrote as a
 * fill (“Choose …”) becomes a choice.
 */
export function sanitizeSteps(steps: RecordedStep[]): RecordedStep[] {
  return steps.map((step) => {
    if (step.kind !== 'fill' || step.checked !== undefined) return step;
    if (step.secret) return { ...step, value: '', secret: secretKey(step.secret) };
    // An older plugin's choice: the option's value only (selectOption finds an option by its value or what it says).
    if (!step.select && !step.values && /^Choose “/.test(step.description)) return { ...step, values: [step.value ?? ''] };
    if (step.select || step.values) return step;
    const words = fieldWords(step);
    if (isSecretHint(words) || looksSecret(step.value ?? '')) {
      const into = / into (.+)$/.exec(step.description)?.[1];
      return { ...step, value: '', secret: secretKey(secretName(/'([^']*)'/.exec(step.locator ?? '')?.[1] ?? words)), description: into ? `Type ${MASK} into ${into}` : `Type ${MASK}` };
    }
    return { ...step, value: maskSecrets(step.value ?? ''), description: maskSecrets(step.description) };
  });
}
