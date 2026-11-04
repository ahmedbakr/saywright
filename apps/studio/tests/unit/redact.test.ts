import { describe, expect, it } from 'vitest';
import { dots, isCodeField, isSecretHint, looksSecret, maskSecrets, redactUrl, scrubEvent, secretEnvName, secretName } from '@saywright/vite/protocol';

describe('secret fields, by what they are called', () => {
  it('knows passwords, codes, keys, tokens and card and bank details, also by autocomplete and in Arabic', () => {
    for (const hint of [
      'password',
      'current-password',
      'new-password',
      'one-time-code',
      'cc-number',
      'cc-csc',
      'cc-exp',
      'cardNumber',
      'card_number',
      'Card number',
      'Name on card',
      'API key',
      'x-api-key',
      'apiKey',
      'Your access token',
      'pwd',
      'user_pin',
      'PIN',
      'Verification code',
      'OTP',
      'IBAN',
      'Gift card code',
      'License key',
      'كلمة المرور',
      'رمز التحقق',
      'رقم البطاقة',
    ])
      expect(isSecretHint(hint), hint).toBe(true);
  });

  it('leaves everyday fields alone: a coupon, a search, a card title, a passenger', () => {
    for (const hint of ['Email', 'Coupon code', 'Promo code', 'Discount code', 'Passenger name', 'Card title', 'Spinner', 'Pinned', 'Opinion', 'Search', 'Secretary', 'Bypass', 'Quantity', 'Shipping', 'Full name'])
      expect(isSecretHint(hint), hint).toBe(false);
  });

  it('names a secret for its test from its label: one name for a password and its confirmation, another for a new one', () => {
    expect(secretName('Enter your password')).toBe('PASSWORD');
    expect(secretName('Confirm password')).toBe('PASSWORD');
    expect(secretName('New password')).toBe('NEW_PASSWORD');
    expect(secretName('Password (8 characters or more)')).toBe('PASSWORD');
    expect(secretName('Card number')).toBe('CARD_NUMBER');
    expect(secretName('كلمة المرور')).toBe('PASSWORD');
    expect(secretName('')).toBe('SECRET');
    expect(secretEnvName('card number')).toBe('SAYWRIGHT_SECRET_CARD_NUMBER');
    expect(secretEnvName("x'); process.exit(1); //")).toBe('SAYWRIGHT_SECRET_X_PROCESS_EXIT_1');
  });
});

describe('secret values, by their look', () => {
  it('spots card numbers (Luhn), provider keys, tokens and long random strings', () => {
    for (const v of [
      '4242 4242 4242 4242',
      '4242424242424242',
      'sk-ant-api03-abcdefghijklmnop',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'Q2xpZW50U2VjcmV0S2V5MTIzNDU2Nzg5',
      'a8f5f167f44f4964e6c998dee827110c',
      'AKIAIOSFODNN7EXAMPLE',
    ])
      expect(looksSecret(v), v).toBe(true);
  });

  it('does not take ordinary values for secrets', () => {
    for (const v of ['SAVE20', '1234 5678 9012 3456', 'hello-world-this-is-a-slug-2024', 'user@example.com', 'The quick brown fox', '550e8400-e29b-41d4-a716-446655440000', '+1 (555) 010-0199', '42'])
      expect(looksSecret(v), v).toBe(false);
  });

  it('masks them inside text, keeping a card’s last four digits', () => {
    expect(maskSecrets('Paid with 4242 4242 4242 4242 (key sk-proj-abcdefghijklmnopqrst), Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Paid with •••• 4242 (key •••), Bearer •••');
    expect(maskSecrets('Order 1234567890123 shipped')).toBe('Order 1234567890123 shipped');
    expect(dots('hunter2')).toBe('•••••••');
    expect(dots('x'.repeat(40))).toHaveLength(12);
  });
});

describe('card numbers, as they are written', () => {
  it.each([
    ['Card 4242 4242 4242 4242', 'Card •••• 4242'],
    ['4242-4242-4242-4242', '•••• 4242'],
    ['4242424242424242', '•••• 4242'],
    ['Amex 3782 822463 10005', 'Amex •••• 0005'],
    // A card followed by more numbers: the card is masked, the rest kept.
    ['4242 4242 4242 4242 2026-10-29', '•••• 4242 2026-10-29'],
  ])('masks %s', (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
  });

  it.each([
    // An order row's cells, run together as the screen's text: a date between numbers is no card.
    'BR-1042 2026-10-29 2 $34.50',
    // A timestamp in milliseconds, and an order id: no card starts with 1, or mixes spaces and dashes.
    'at 1793806331937 ms',
    '4242 4242-4242 4242',
    // Groups too short for a card.
    '42 42 42 42 42 42 42 42',
  ])('leaves %s as it is', (text) => {
    expect(maskSecrets(text)).toBe(text);
  });
});

describe('codes that let someone in', () => {
  const numeric = { numeric: true, shortMax: true };
  const plain = { numeric: false, shortMax: false };
  it.each([
    ['Code', numeric, ''],
    ['Enter the 6-digit code we emailed you', numeric, ''],
    ['code', { numeric: false, shortMax: true }, ''],
    ['Code', plain, '/verify'],
    ['Code', plain, '/auth/callback'],
  ])('a field called %s is one', (hint, field, page) => {
    expect(isCodeField(hint, field, page)).toBe(true);
  });

  it.each([
    ['Coupon code', numeric, ''],
    ['Promo code', numeric, '/checkout'],
    ['ZIP code', numeric, ''],
    ['Postal code', numeric, '/login'],
    ['Code', plain, '/checkout'],
    ['Discount code', plain, '/verify'],
  ])('a field called %s is not', (hint, field, page) => {
    expect(isCodeField(hint, field, page)).toBe(false);
  });
});

describe('addresses', () => {
  it('masks tokens, keys, signatures and sign-in codes in queries and hashes, and leaves the rest', () => {
    expect(redactUrl('/api/reset?token=abc123&lang=en')).toBe('/api/reset?token=•••&lang=en');
    expect(redactUrl('/auth/callback?code=4/0AY0e-g7&state=xyz')).toBe('/auth/callback?code=•••&state=•••');
    expect(redactUrl('/checkout?code=SAVE20')).toBe('/checkout?code=SAVE20');
    expect(redactUrl('https://app.example.com/#access_token=ya29.a0AfH6SM&token_type=bearer')).toBe('https://app.example.com/#access_token=•••&token_type=•••');
    expect(redactUrl('/#/orders?tab=1')).toBe('/#/orders?tab=1');
    expect(redactUrl('/files/report.pdf?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE')).toBe('/files/report.pdf?X-Amz-Signature=•••&X-Amz-Credential=•••');
    expect(redactUrl('/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('/verify/•••');
    expect(redactUrl('/search?q=red%20shoes&api_key=12345&page=2')).toBe('/search?q=red%20shoes&api_key=•••&page=2');
    expect(redactUrl('')).toBe('');
  });
});

describe('session events, scrubbed as they are kept', () => {
  it('masks a value an older plugin recorded in clear, when its field is called like a secret or the value looks like one', () => {
    const typed = scrubEvent({ type: 'input', el: { label: 'API key', name: 'input', text: '' }, value: 'sk-live-abcdefghijklmnop1234', masked: false });
    expect(typed).toMatchObject({ value: '••••••••••••', masked: true, secret: 'API_KEY' });
    const plain = scrubEvent({ type: 'input', el: { label: 'Coupon', name: 'input', text: '' }, value: 'SAVE20', masked: false });
    expect(plain).toMatchObject({ value: 'SAVE20', masked: false });
  });

  it('masks addresses, response bodies, errors and what the screen said', () => {
    expect(scrubEvent({ type: 'net', url: '/api/me?access_token=abc', body: 'invalid key sk-proj-abcdefghijklmnopqrst', ok: false })).toMatchObject({ url: '/api/me?access_token=•••', body: 'invalid key •••' });
    expect(scrubEvent({ type: 'page', url: '/reset?token=t0k3n', referrer: 'https://mail.example.com/?sig=abc' })).toMatchObject({ url: '/reset?token=•••', referrer: 'https://mail.example.com/?sig=•••' });
    expect(scrubEvent({ type: 'error', message: 'Bad card 4242424242424242', stack: 'at pay (Bearer abcdefghijklmnopqrstuvwxyz)' })).toMatchObject({ message: 'Bad card •••• 4242', stack: 'at pay (Bearer •••)' });
    expect(scrubEvent({ type: 'dom', url: '/', text: 'Your key: ghp_abcdefghijklmnopqrstuvwxyz0123456789', headings: ['Card 4242 4242 4242 4242'] })).toMatchObject({ text: 'Your key: •••', headings: ['Card •••• 4242'] });
    expect(scrubEvent({ type: 'click', el: { label: 'Copy', text: 'sk-ant-api03-abcdefghijklmnop' } })).toMatchObject({ el: { text: '•••' } });
  });
});
