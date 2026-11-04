/**
 * What is never recorded: passwords, one-time codes, keys and tokens, card and bank numbers. The bridge's two
 * recorders (test sessions, and Write test), the studio (for what an older plugin still sends), the tests it writes
 * and what it sends an AI all go by these rules, so a secret is caught the same way wherever it would show.
 *
 * A field is secret by what it is (a password field, a field someone marked private) or by what it is called (its
 * name, id, autocomplete, label or placeholder: “Password”, “cc-number”, “API key”, “رمز التحقق”). A value is secret
 * by its look alone (a card number, a key or a token), whatever its field is called. A test types a secret from the
 * environment (SAYWRIGHT_SECRET_PASSWORD), never from its own file.
 */

/** Shown in place of a secret. */
export const MASK = '•••';

/** A generated test reads the secret named PASSWORD from the environment variable SAYWRIGHT_SECRET_PASSWORD. */
export const SECRET_ENV_PREFIX = 'SAYWRIGHT_SECRET_';

/** A value as it may be shown: a dot for each character, at most twelve, so its length is a hint and nothing more. */
export function dots(value: string): string {
  return '•'.repeat(Math.min(value.length, 12));
}

/** A name, id or label as plain words: “cardNumber”, “card_number”, “cc-number” → “card number”, “cc number”. */
export function words(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

/** Words that make a field secret, whatever else it is called. */
const SECRET_WORDS = new RegExp(
  '\\b(?:' +
    [
      'pass(?:word|wd|code|phrase|key)s?',
      'pwd',
      'pw',
      'secrets?',
      'tokens?',
      'api ?keys?',
      'access ?keys?',
      'secret ?keys?',
      'private ?keys?',
      'client ?secrets?',
      'licen[cs]e ?keys?',
      'product ?keys?',
      'activation ?(?:keys?|codes?)',
      'recovery ?(?:keys?|codes?)',
      'backup ?codes?',
      'auth(?:entication|orization)? ?codes?',
      'otp',
      'totp',
      'one ?time ?(?:codes?|passwords?|passcodes?|pins?)',
      '(?:verification|security|confirmation|sms|2fa|mfa) ?codes?',
      '2fa',
      'mfa',
      'cvv2?',
      'cvc2?',
      'csc',
      'card ?(?:numbers?|num|no|codes?|verification|holder|security|expiry|expiration|exp|cvc|cvv)',
      'name ?on ?card',
      'credit ?cards?',
      'debit ?cards?',
      'cc ?(?:number|num|no|exp|expiry|csc|cvc|cvv|name|given|family|type)',
      'iban',
      'account ?(?:numbers?|num|no)',
      'routing ?(?:numbers?|num|no)',
      'sort ?codes?',
      'ssn',
      'social ?security',
      'tax ?id',
      'national ?id',
      'passports?',
      'pins?(?: ?codes?)?',
      '(?:recovery|seed|secret|backup|mnemonic) ?(?:phrases?|words?)',
      'mnemonics?',
      '(?:security|secret) ?(?:questions?|answers?)',
      'memorable ?(?:words?|information|info)',
      'mother s maiden name',
    ].join('|') +
    ')\\b',
);

/** The same in Arabic (password, secret code, verification code, card number, account number). */
const SECRET_WORDS_AR = /كلمة (?:ال)?(?:مرور|سر)|(?:ال)?رمز (?:ال)?(?:سري|تحقق|التحقق|أمان|الأمان|المرور)|رقم (?:ال)?(?:بطاقة|حساب|سري)|آيبان/;

/** Whether a field described so (its type, name, id, autocomplete, label and placeholder, in one text) holds a secret. */
export function isSecretHint(hint: string): boolean {
  return SECRET_WORDS.test(words(hint)) || SECRET_WORDS_AR.test(hint);
}

/** Words a field's label adds that don't tell one secret from another. */
const FILLER = new Set(['enter', 'your', 'the', 'a', 'an', 'please', 'type', 'confirm', 'confirmation', 'repeat', 'again', 're', 'retype', 'field', 'here', 'of', 'required', 'optional']);
/** A word before a secret that does tell it from another: a new password isn't the current one. */
const QUALIFIER = new Set(['new', 'old', 'current', 'previous', 'admin', 'master', 'root']);

/**
 * What a secret is called in a test, from its field's label (or name): “Enter your password” → PASSWORD, “Card
 * number” → CARD_NUMBER, “New password” → NEW_PASSWORD, “Password (8 characters or more)” → PASSWORD; “Confirm
 * password” is PASSWORD too, so one value fills both.
 */
export function secretName(label: string): string {
  const w = words(label);
  const m = SECRET_WORDS.exec(w);
  let name: string[];
  if (m) {
    const before = w.slice(0, m.index).trim().split(' ').pop() ?? '';
    name = [...(QUALIFIER.has(before) ? [before] : []), ...m[0].split(' ')];
  } else {
    name = w.split(' ').filter((x) => x && !FILLER.has(x) && /^[a-z0-9]+$/.test(x)).slice(0, 3);
  }
  if (name.length) return name.join('_').toUpperCase().slice(0, 40);
  if (/كلمة (?:ال)?(?:مرور|سر)/.test(label)) return 'PASSWORD';
  if (/تحقق|التحقق/.test(label)) return 'VERIFICATION_CODE';
  if (/بطاقة/.test(label)) return 'CARD_NUMBER';
  return 'SECRET';
}

/** A secret's name as an environment variable can take it: capitals, digits and underscores. */
export function secretEnvName(name: string): string {
  return SECRET_ENV_PREFIX + (name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SECRET');
}

/** What may be a card number: digits with spaces or dashes between them (isCard decides). */
const CARD = /\b\d(?:[ -]?\d){12,22}\b/g;

/** Keys and tokens by their shape. */
const TOKENS: RegExp[] = [
  // A JSON Web Token: three base64url parts, the first two JSON.
  /\beyJ[\w-]{6,}\.eyJ[\w-]{6,}\.[\w-]{6,}/g,
  // AI providers' keys (sk-…, sk-ant-…, sk-proj-…), and Stripe's secret and restricted keys.
  /\b(?:sk|rk)-[\w-]{16,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  // GitHub, GitLab, Slack, npm, AWS and Google keys.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[\w-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  // Stripe's webhook signing secrets, and SendGrid's keys.
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bSG\.[\w-]{16,}\.[\w-]{16,}/g,
  // An AWS secret access key, or any other secret, given after its name (aws_secret_access_key=…, "clientSecret": "…").
  /(?<=\b(?:aws_?secret_?access_?key|secret_?access_?key|client_?secret|api_?secret|private_?key|access_?token|refresh_?token|auth_?token|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;}{]{8,}/gi,
  // A random token after a short prefix of its kind (rt_…, rst_…, pk_live_…): letters in both cases and digits.
  /\b[a-z]{2,8}_(?:(?:live|test)_)?(?=[A-Za-z0-9]{20,}\b)(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{20,}\b/g,
  // A bearer token in a header someone printed, and a private key.
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Whether digits are written as a card number is: 13 to 19 of them, starting with 2 to 6 (as cards of every network
 * do), passing the Luhn check, and either unbroken or in groups of 4 to 6 (the last one shorter) with one kind of
 * separator. Not a date with a number either side of it, an order row or a timestamp.
 */
function isCard(text: string): boolean {
  const d = text.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19 || !/^[2-6]/.test(d) || !luhn(d)) return false;
  if (/^\d+$/.test(text)) return true;
  if (text.includes(' ') && text.includes('-')) return false;
  const groups = text.split(/[ -]/);
  return groups.every((g) => /^\d+$/.test(g)) && groups.slice(0, -1).every((g) => g.length >= 4 && g.length <= 6) && groups[groups.length - 1].length <= 6;
}

/** A card number in `run` (digits with spaces or dashes), with what follows it kept: the longest first part that is one. */
function maskCard(run: string): string {
  const parts = run.split(/(?<=\d)(?=[ -])/);
  for (let k = parts.length; k > 0; k--) {
    const head = parts.slice(0, k).join('');
    if (isCard(head)) return `•••• ${head.replace(/\D/g, '').slice(-4)}${parts.slice(k).join('')}`;
  }
  return run;
}

/** Text with every card number (kept: its last four digits) and every key- or token-shaped string in it masked. */
export function maskSecrets(text: string): string {
  if (!text) return text;
  let out = text.replace(CARD, maskCard);
  // The password in an address that carries one: postgres://ledger:password@db.local/ledger.
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)@/gi, (_m, head: string) => `${head}${MASK}@`);
  for (const re of TOKENS) out = out.replace(re, (m) => (m.startsWith('Bearer') ? `Bearer ${MASK}` : MASK));
  return out;
}

/**
 * Whether a typed value is a secret by its look alone: a card number, a key or a token, or a long random string (of
 * letters in both cases and digits, as keys are; or 32 hexadecimal digits or more). A slug, a sentence, an email
 * address or a coupon code is not.
 */
export function looksSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 12) return false;
  if (maskSecrets(v) !== v) return true;
  if (/^[a-f0-9]{32,}$/i.test(v) && /\d/.test(v) && /[a-f]/i.test(v)) return true;
  return /^[A-Za-z0-9+/_=-]{24,}$/.test(v) && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
}

/** Query and hash parameters whose value is a secret by their name alone. */
const SECRET_PARAM =
  /^(?:access_?token|refresh_?token|id_?token|auth_?token|token|auth|authorization|api_?key|apikey|key|secret|client_?secret|password|passwd|pwd|pass|otp|code_?verifier|jwt|session|session_?id|sessionid|sid|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$/i;
/** Addresses of sign-in steps, where `code`, `state` and `nonce` carry what lets someone in. */
const AUTH_PATH = /(?:^|\/)(?:callback|oauth2?|auth|authorize|sso|login|signin|sign-in|verify|magic|reset|confirm)(?:[/?#.]|$)/i;

/** Whether a page's path is a sign-in step's (/login, /verify, /auth/callback…): a code asked for there lets someone in. */
export function isAuthPath(pathname: string): boolean {
  return AUTH_PATH.test(pathname);
}

/** Codes that are not secrets: a test needs them as typed (SAVE20, a postal code, a colour). */
const PLAIN_CODE = /\b(?:coupon|promo|promotion|discount|voucher|gift|referral|invite|invitation|postal|post|zip|area|country|dialling|dialing|product|sku|item|colou?r|tracking|order|booking|reference|ref|course|class|group|room|seat|ticket|event|campaign|source|language|currency|qr|bar|barcode|html|css|snippet|embed|promotional)\b/;

/**
 * Whether a field described so asks for a code that lets someone in, by its look: called a code or a PIN (“Code”,
 * “Enter the 6-digit code we emailed you”), not a coupon or a postal code, and short and numeric (its input mode,
 * type, pattern or length), or asked for on a sign-in step's page.
 */
export function isCodeField(hint: string, field: { numeric: boolean; shortMax: boolean }, pathname = ''): boolean {
  const w = words(hint);
  if (!/\b(?:code|codes|pin|passcode)\b/.test(w) || PLAIN_CODE.test(w)) return false;
  return field.numeric || field.shortMax || isAuthPath(pathname);
}

function decoded(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** `a=1&b=2` with the values of secret parameters masked, and key- or token-shaped values too. */
function maskParams(params: string, authPath: boolean): string {
  return params
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return maskSecrets(pair);
      const name = decoded(pair.slice(0, eq));
      const value = pair.slice(eq + 1);
      if (!value) return pair;
      const secret = SECRET_PARAM.test(name) || isSecretHint(name) || (authPath && /^(?:code|state|nonce)$/i.test(name)) || looksSecret(decoded(value));
      return `${pair.slice(0, eq)}=${secret ? MASK : maskSecrets(value)}`;
    })
    .join('&');
}

/**
 * An address with the secrets in it masked: the values of parameters named like a token, key, password or session
 * (in its query, and in its hash: `#access_token=…`), sign-in codes, and key- or token-shaped parts of its path.
 * Works on whole and relative addresses, and never throws.
 */
export function redactUrl(url: string): string {
  if (!url) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? null : url.slice(hashAt + 1);
  const q = base.indexOf('?');
  const path = q < 0 ? base : base.slice(0, q);
  const authPath = AUTH_PATH.test(path);
  // A part of the path that is a token (/invite/k3Jq…, /reset/…): long, random, letters in both cases and digits.
  let out = maskSecrets(path).replace(/(?<=\/)[A-Za-z0-9_-]{24,}(?=\/|$)/g, (part) => (/\d/.test(part) && /[a-z]/.test(part) && /[A-Z]/.test(part) ? MASK : part));
  if (q >= 0) out += `?${maskParams(base.slice(q + 1), authPath)}`;
  if (hash !== null) {
    // A hash router's route (#/orders?tab=1), or parameters (#access_token=…&token_type=bearer).
    const hq = hash.indexOf('?');
    if (hq >= 0) out += `#${maskSecrets(hash.slice(0, hq))}?${maskParams(hash.slice(hq + 1), authPath || AUTH_PATH.test(hash.slice(0, hq)))}`;
    else out += `#${hash.includes('=') ? maskParams(hash, authPath) : maskSecrets(hash)}`;
  }
  return out;
}

/** A recorded element's words, masked: text it showed may hold a card number or a key. */
function scrubTarget(el: unknown): void {
  if (!el || typeof el !== 'object') return;
  const t = el as { label?: unknown; text?: unknown; description?: unknown };
  if (typeof t.label === 'string') t.label = maskSecrets(t.label);
  if (typeof t.text === 'string') t.text = maskSecrets(t.text);
  if (typeof t.description === 'string') t.description = maskSecrets(t.description);
}

/**
 * A session event as it may be kept: addresses with their secrets masked (see redactUrl), card numbers and keys
 * masked in every text it carries (errors, console lines, response bodies, what the screen said), and a typed value
 * that is a secret (by its field's name, or its look) as dots. The bridge records events so; the studio scrubs
 * what arrives again, for events an older plugin recorded. Changes the event in place, and returns it.
 */
export function scrubEvent<T extends { type: string }>(event: T): T {
  const e = event as unknown as Record<string, unknown> & { type: string };
  const url = (k: string) => {
    if (typeof e[k] === 'string') e[k] = redactUrl(e[k] as string);
  };
  const text = (k: string) => {
    if (typeof e[k] === 'string') e[k] = maskSecrets(e[k] as string);
  };
  scrubTarget(e.el);
  switch (e.type) {
    case 'page':
      url('url');
      url('referrer');
      break;
    case 'nav':
      url('url');
      break;
    case 'net':
      url('url');
      text('body');
      text('error');
      break;
    case 'error':
    case 'console':
      text('message');
      text('text');
      text('stack');
      break;
    case 'dom':
      url('url');
      text('text');
      if (Array.isArray(e.headings)) e.headings = e.headings.map((h) => (typeof h === 'string' ? maskSecrets(h) : h));
      break;
    case 'input': {
      const target = (e.el ?? {}) as { label?: string; name?: string };
      const value = typeof e.value === 'string' ? e.value : '';
      if (!e.masked && (isSecretHint(`${target.label ?? ''} ${target.name ?? ''}`) || looksSecret(value))) {
        e.value = dots(value);
        e.masked = true;
        e.secret ??= secretName(target.label || target.name || '');
      } else if (!e.masked) text('value');
      break;
    }
    case 'change':
      text('value');
      if (Array.isArray(e.options)) e.options = e.options.map((o) => (typeof o === 'string' ? maskSecrets(o) : o));
      break;
  }
  return event;
}
