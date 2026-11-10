/**
 * Autopilot's turn: what the AI is told about the page and the run so far, which controls it may not use, what
 * happens when it names a control that isn't there, presses a key without one or goes round in circles; and a run
 * that can't start (no AI, or the budget is used up) leaving no session behind.
 */
import type { PageControl, PageSnapshot } from '@saywright/vite/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeStep, isRisky, notAllowed, pageStateOf, riskOf } from '../../shared/autopilot';
import { autopilotRoutes, nextTurn, turnPrompt, type AutopilotTurn, type TurnInput } from '../../server/autopilot';
import { AgentError } from '../../server/ai/types';
import type { JsonRequest } from '../../server/ai/service';
import { HttpError, type Router } from '../../server/http';
import type { Sessions } from '../../server/sessions/index';
import { Autopilot, type AutopilotHost } from '../../src/core/autopilot';

const calls = vi.hoisted(() => [] as { method: string; path: string }[]);
const refuse = vi.hoisted(() => ({ ready: null as null | { status: number; message: string }, turn: null as null | { status: number; message: string }, turns: [] as unknown[], posted: [] as { path: string; body: unknown }[] }));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  const call = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path });
    refuse.posted.push({ path, body });
    if (path === '/autopilot/ready' && refuse.ready) throw new ApiError(refuse.ready.status, refuse.ready.message);
    if (path === '/autopilot/turn' && refuse.turn) throw new ApiError(refuse.turn.status, refuse.turn.message);
    if (path === '/autopilot/turn' && refuse.turns.length) return { turn: refuse.turns.shift() };
    if (path === '/sessions' && method === 'POST') return { session: { id: 's1' }, key: 'k' };
    return { ok: true };
  };
  return { ApiError, api: { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string) => call('PUT', p), delete: (p: string) => call('DELETE', p) } };
});

const page: PageSnapshot = {
  url: 'http://localhost:5174/#/checkout',
  title: 'Tidewell · Checkout',
  headings: ['Checkout', 'Order summary'],
  text: 'Subtotal $86.00 Shipping $12.00 Total $98.00',
  controls: [
    { locator: "page.getByLabel('Coupon')", role: 'textbox', name: 'Coupon', field: { type: 'text', value: '', required: false }, disabled: false, offscreen: false, src: 'src/components/CouponField.tsx:44:7' },
    { locator: "page.getByRole('button', { name: 'Apply' })", role: 'button', name: 'Apply', disabled: false, offscreen: false, src: 'src/components/CouponField.tsx:45:7' },
    { locator: "page.getByRole('button', { name: 'Pay $98.00' })", role: 'button', name: 'Pay $98.00', disabled: false, offscreen: true, src: 'src/components/OrderSummary.tsx:40:9' },
  ],
  more: 0,
  dialog: null,
  viewport: [1280, 800],
};
const input = (over: Partial<TurnInput> = {}): TurnInput => ({ goal: 'Apply SAVE20', step: 2, maxSteps: 20, allowRisky: false, snapshot: page, history: [{ n: 1, did: 'Clicked “Checkout”', ok: true, url: page.url }], signals: [], reported: [], ...over });

describe('the prompt', () => {
  it('shows the page, numbered controls with their state, the steps so far and what the app did', () => {
    const { text } = turnPrompt(input({ signals: ['Failed request: POST /api/coupon → 500'], reported: ['Total is wrong'] }));
    expect(text).toContain('Goal: Apply SAVE20');
    expect(text).toContain('Step 2 of at most 20.');
    expect(text).toContain('[1] textbox “Coupon” text, holds “”');
    expect(text).toContain('[2] button “Apply”');
    expect(text).toContain('[3] button “Pay $98.00” (below or above the visible part) (not allowed)');
    expect(text).toContain('1. Clicked “Checkout”');
    expect(text).toContain('- Failed request: POST /api/coupon → 500');
    expect(text).toContain('Problems already reported: “Total is wrong”');
  });

  it('lets the AI use every control when allowed', () => {
    expect(turnPrompt(input({ allowRisky: true })).text).not.toContain('(not allowed)');
  });

  it('explores without a goal', () => {
    expect(turnPrompt(input({ goal: ' ' })).text).toContain('Goal: Explore the app and find problems in its main features.');
  });
});

describe('controls it leaves alone', () => {
  it('knows deleting, paying, sending and signing out, in English and Arabic', () => {
    for (const name of ['Delete account', 'Pay $98.00', 'Place order', 'Send', 'Log out', 'Sign out', 'حذف الحساب', 'ادفع الآن', 'تسجيل الخروج']) expect(isRisky(name)).toBe(true);
    for (const name of ['Apply', 'Add to cart', 'Checkout', 'Sender name', 'Display settings', 'Save', 'Cancel']) expect(isRisky(name)).toBe(false);
  });

  const url = 'http://localhost:7551/auto';
  const click = { kind: 'click' as const, control: 1 };
  const button = (name: string, about?: PageControl['about']): PageControl => ({ locator: `page.getByRole('button', { name: '${name}' })`, role: 'button', name, disabled: false, offscreen: false, src: null, ...(about ? { about } : {}) });

  it('judges what a control is, not only what it is called (the audit’s admin page)', () => {
    const risky: [string, PageControl][] = [
      ['icon-only trash button', button('', { classes: 'icon-trash', context: 'Grace Hopper' })],
      ['lucide icon', button('', { words: 'lucide lucide-trash-2', context: 'Row 2' })],
      ['svg use id', button('', { words: 'icon-delete' })],
      ['danger variant', button('Yes', { classes: 'btn btn-danger' })],
      ['destructive variant', button('Confirm', { classes: 'inline-flex destructive' })],
      ['title only', button('✕', { words: 'Remove member' })],
      ['data-method', { ...button('Grace'), role: 'link', about: { method: 'delete', href: 'http://localhost:7551/users/7' } }],
      ['the app asks first', button('Archive', { confirms: true })],
      ['link to sign out', { ...button('Exit'), role: 'link', about: { href: 'http://localhost:7551/logout' } }],
      ['link to another site', { ...button('Docs'), role: 'link', about: { href: 'https://other.example/docs' } }],
      ['form posting to delete', button('Yes, continue', { form: { action: 'http://localhost:7551/account/delete', method: 'post' } })],
      ['form with delete method', button('Save', { form: { action: 'http://localhost:7551/users/7', method: 'delete' } })],
      ['alert dialog confirm', button('OK', { dialog: { alert: true, text: 'Are you sure?' } })],
      ['dialog about deleting', button('Yes', { dialog: { alert: false, text: 'Delete 3 items? This can’t be undone.' } })],
      ['no name at all', button('')],
    ];
    for (const [what, c] of risky) expect(riskOf(click, c, url), what).not.toBeNull();
    for (const name of ['Clear all', 'Cancel order', 'Cancel my subscription', 'Deactivate', 'Unsubscribe', 'Submit payment', 'Complete payment', 'Place order', 'Order now', 'Donate $50', 'Empty trash', 'Factory reset', 'Revoke access', 'Wipe device', 'Terminate instance', 'Drop table', 'Email all customers', 'Send feedback', 'Refund', 'Log off', 'Sign off', 'Leave team', 'Ban user', 'Uninstall', 'Remove', 'Remove member', 'Remove filter', 'Pay later',
      'حذف', 'إزالة', 'مسح الكل', 'إتمام الطلب', 'إلغاء الطلب', 'تعطيل الحساب', 'تسجيل الخروج',
      'Supprimer', 'Payer', 'Se déconnecter', 'Eliminar', 'Cerrar sesión', 'Löschen', 'Jetzt kaufen', 'Abmelden', 'Excluir', 'Finalizar compra', 'Elimina', 'Esci', 'Sil', 'Satın al', 'Çıkış yap'])
      expect(riskOf(click, button(name), url), name).not.toBeNull();
  });

  it('says why in the step it skipped', () => {
    expect(riskOf(click, button('', { classes: 'icon-trash' }), url)).toBe('its icon or style says “trash”');
    expect(riskOf(click, { ...button('Exit'), role: 'link', about: { href: 'http://localhost:7551/logout' } }, url)).toBe('it goes to an address that says “logout”');
  });

  it('leaves the controls of ordinary use alone', () => {
    const fine: PageControl[] = [
      button('Open menu', { words: 'Open menu lucide lucide-menu' }),
      { ...button('Next page'), role: 'link', about: { href: 'http://localhost:7551/products?page=2' } },
      button('Add to cart', { classes: 'btn btn-primary' }),
      button('Apply', { form: { action: 'http://localhost:7551/cart/coupon', method: 'post' } }),
      button('Search', { form: { action: 'http://localhost:7551/search', method: 'get' } }),
      button('Sort by price'),
      { ...button('Shipping'), role: 'tab' },
      { ...button('Cancel'), about: { dialog: { alert: true, text: 'Delete this order?' } } },
      { ...button('Checkout'), role: 'link', about: { href: 'http://localhost:7551/checkout' } },
      { ...button('Payment methods'), role: 'link', about: { href: 'http://localhost:7551/settings/billing' } },
      button('Ordina per prezzo'),
      button('Save', { dialog: { alert: false, text: 'Edit profile' } }),
      { ...button('Email'), role: 'textbox', field: { type: 'email', value: '', required: true } },
    ];
    for (const c of fine) expect(riskOf(click, c, url), c.name).toBeNull();
  });

  it('doesn’t open an address that says it deletes or signs out, nor another site', () => {
    expect(riskOf({ kind: 'goto', value: '/logout' }, undefined, url)).not.toBeNull();
    expect(riskOf({ kind: 'goto', value: '/account/delete' }, undefined, url)).not.toBeNull();
    expect(riskOf({ kind: 'goto', value: '/api/users/7?_method=DELETE' }, undefined, url)).not.toBeNull();
    expect(riskOf({ kind: 'goto', value: '/products/2' }, undefined, url)).toBeNull();
    expect(notAllowed({ kind: 'goto', value: '/logout' }, undefined, true, url)).toBe(false);
  });
});

describe('a turn', () => {
  const answer =
    (value: unknown) =>
    async <T,>(_req: JsonRequest<T>) => ({ value: value as T, model: 'test' });

  it('comes back as the AI chose it, with at most three findings', async () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({ severity: 'low', title: `Problem ${i}`, expected: 'a', actual: 'b' }));
    const { turn } = await nextTurn(input(), answer({ thought: 'Try the coupon.', action: { kind: 'fill', control: 1, value: 'SAVE20' }, findings }));
    expect(turn.action).toEqual({ kind: 'fill', control: 1, value: 'SAVE20' });
    expect(turn.findings).toHaveLength(3);
  });

  it('ends when the AI names a control that isn’t on the page', async () => {
    const { turn } = await nextTurn(input(), answer({ thought: 'Click it.', action: { kind: 'click', control: 9 }, findings: [] }));
    expect(turn.action.kind).toBe('done');
    expect(turn.summary).toMatch(/isn't on the page \(9\)/);
  });
});

describe('steps in words', () => {
  it('reads like what a person did', () => {
    const coupon = { name: 'Coupon', role: 'textbox' };
    expect(describeStep({ kind: 'fill', control: 1, value: 'SAVE20' }, coupon)).toBe('Typed “SAVE20” into “Coupon”');
    expect(describeStep({ kind: 'check', value: 'off' }, { name: 'Gift wrap', role: 'checkbox' })).toBe('Unticked “Gift wrap”');
    expect(describeStep({ kind: 'press' }, coupon)).toBe('Pressed Enter in “Coupon”');
    expect(describeStep({ kind: 'goto', value: '/settings' }, undefined)).toBe('Opened /settings');
  });

  it('never writes down what it typed into a secret field, or a value that looks like one', () => {
    // The field says it is secret; its name does (an older plugin says nothing); the value is a card number.
    expect(describeStep({ kind: 'fill', control: 1, value: '862' }, { name: 'Security digits', role: 'textbox', field: { secret: true } })).toBe('Typed ••• into “Security digits”');
    expect(describeStep({ kind: 'fill', control: 1, value: '123' }, { name: 'CVC', role: 'textbox' })).toBe('Typed ••• into “CVC”');
    expect(describeStep({ kind: 'fill', control: 1, value: '4242 4242 4242 4242' }, { name: 'Number', role: 'textbox' })).toBe('Typed ••• into “Number”');
    expect(describeStep({ kind: 'fill', control: 1, value: 'sk-live-abcdefghijklmnop1234' }, { name: 'Notes', role: 'textbox' })).toBe('Typed ••• into “Notes”');
  });
});

describe('what it leaves alone', () => {
  const cvc = { name: 'CVC', submits: 'Pay $45.45 and subscribe' };
  it('doesn’t press Enter in a field whose form that would send with a risky button, unless allowed', () => {
    expect(notAllowed({ kind: 'press', control: 1 }, cvc, false)).toBe(true);
    expect(notAllowed({ kind: 'press', control: 1, value: 'Enter' }, cvc, false)).toBe(true);
    expect(notAllowed({ kind: 'press', control: 1 }, cvc, true)).toBe(false);
    // Typing in that field, another key, or Enter in a form sent with a harmless button is fine.
    expect(notAllowed({ kind: 'fill', control: 1, value: '862' }, cvc, false)).toBe(false);
    expect(notAllowed({ kind: 'press', control: 1, value: 'Tab' }, cvc, false)).toBe(false);
    expect(notAllowed({ kind: 'press', control: 1 }, { name: 'Coupon', submits: 'Apply' }, false)).toBe(false);
    expect(notAllowed({ kind: 'click', control: 1 }, { name: 'Delete account' }, false)).toBe(true);
  });
});

describe('what it may not report', () => {
  it('is told that a value it made up being rejected is expected, and to call a value wrong only when the page shows why', () => {
    const { system } = turnPrompt(input());
    expect(system).toContain('A code, coupon, email, account or other value you made up being rejected is expected');
    expect(system).toContain('Call a value wrong only when you can show why from the page');
  });
});

describe('a key press without a control', () => {
  const answer =
    (value: unknown) =>
    async <T,>(_req: JsonRequest<T>) => ({ value: value as T, model: 'test' });

  it('goes to the focused control, which the prompt marks', async () => {
    const focused = { ...page, focused: 0 };
    expect(turnPrompt(input({ snapshot: focused })).text).toContain('[1] textbox “Coupon” text, holds “” (focused)');
    const { turn } = await nextTurn(input({ snapshot: focused }), answer({ thought: 'Send the code with Enter.', action: { kind: 'press', value: 'Enter' }, findings: [] }));
    expect(turn.action).toEqual({ kind: 'press', value: 'Enter', control: 1 });
  });

  it('goes to the page when nothing has the focus, instead of ending the run', async () => {
    const { turn } = await nextTurn(input(), answer({ thought: 'Close the menu.', action: { kind: 'press', value: 'Escape' }, findings: [] }));
    expect(turn.action).toEqual({ kind: 'press', value: 'Escape' });
    expect(describeStep(turn.action, undefined)).toBe('Pressed Escape');
  });
});

describe('going round in circles', () => {
  const here = pageStateOf(page);
  const twice = [
    { n: 3, did: 'Clicked “Apply”', ok: true, url: page.url, page: here },
    { n: 4, did: 'Clicked “Remove”', ok: true, url: page.url, page: 'other' },
    { n: 5, did: 'Clicked “Apply”', ok: true, url: page.url, page: here },
  ];
  const turns = (...values: AutopilotTurn[]) => {
    const asked: string[] = [];
    let i = 0;
    const ask = async <T,>(req: JsonRequest<T>) => {
      asked.push(req.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
      return { value: values[Math.min(i++, values.length - 1)] as T, model: 'test' };
    };
    return { ask, asked };
  };
  const apply: AutopilotTurn = { thought: 'Apply again.', action: { kind: 'click', control: 2 }, findings: [] };

  it('tells the AI when it is back on a page it has seen, and what it did there', () => {
    expect(turnPrompt(input({ history: twice })).text).toContain('You have been on this exact page before. Here you already: Clicked “Apply” (step 3, 5).');
    // A page that has changed since is a new page.
    expect(turnPrompt(input({ history: twice, snapshot: { ...page, text: 'Discount −$17.20' } })).text).not.toContain('this exact page');
  });

  it('asks again once when the same step on the same page comes back a third time, and takes a new one', async () => {
    const { ask, asked } = turns(apply, { thought: 'Try the coupon field instead.', action: { kind: 'fill', control: 1, value: 'WELCOME10' }, findings: [] });
    const { turn } = await nextTurn(input({ history: twice }), ask);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('You chose: Clicked “Apply”. You already did exactly that on this same page (step 3, 5)');
    expect(turn.action).toEqual({ kind: 'fill', control: 1, value: 'WELCOME10' });
  });

  it('ends the run when it insists, keeping what it found', async () => {
    const found = { severity: 'medium' as const, title: 'Discount includes shipping', expected: '$8.60', actual: '−$9.80' };
    const { ask } = turns({ ...apply, findings: [found] }, apply);
    const { turn } = await nextTurn(input({ history: twice }), ask);
    expect(turn.action.kind).toBe('done');
    expect(turn.summary).toBe('Stopped: it kept choosing “Clicked “Apply”” on a page that didn’t change.');
    expect(turn.findings).toEqual([found]);
  });

  it('lets it do a thing twice', async () => {
    const { ask, asked } = turns(apply);
    const { turn } = await nextTurn(input({ history: twice.slice(0, 2) }), ask);
    expect(asked).toHaveLength(1);
    expect(turn.action).toEqual({ kind: 'click', control: 2 });
  });

  it('caches the system prompt it sends every turn', async () => {
    let cache: unknown;
    await nextTurn(input(), async <T,>(req: JsonRequest<T>) => ((cache = req.cache), { value: apply as T, model: 'test' }));
    expect(cache).toBe('system');
  });
});

describe('a run that can’t start', () => {
  type Handler = (req: { body: unknown }) => unknown;
  const routes = (deps: Partial<Parameters<typeof autopilotRoutes>[1]>) => {
    const handlers = new Map<string, Handler>();
    const router = { post: (p: string, h: Handler) => handlers.set(p, h) } as unknown as Router;
    autopilotRoutes(router, { sessions: () => ({}) as Sessions, ask: () => async () => ({ value: {} as never, model: 'm' }), ...deps });
    return handlers;
  };
  const statusOf = async (run: () => unknown) => {
    try {
      await run();
      return 200;
    } catch (err) {
      return err instanceof HttpError ? err.status : 500;
    }
  };

  it('is refused before a session exists: 402 when the budget says stop, 409 without an AI', async () => {
    const budget = routes({
      gate: () => {
        throw new AgentError('Used $4.00 of your $4.00 daily budget.', 'budget');
      },
    });
    expect(await statusOf(() => budget.get('/autopilot/ready')!({ body: {} }))).toBe(402);
    expect(await statusOf(() => routes({ ask: () => null }).get('/autopilot/ready')!({ body: {} }))).toBe(409);
    expect(await statusOf(() => routes({}).get('/autopilot/ready')!({ body: {} }))).toBe(200);
  });

  it('answers a budget stop during the run with 402, not a server error', async () => {
    const sessions = { store: { meta: () => ({ source: 'autopilot', status: 'recording' }) }, notableSince: () => [] } as unknown as Sessions;
    const h = routes({
      sessions: () => sessions,
      ask: () => async () => {
        throw new AgentError('Used $4.00 of your $4.00 daily budget.', 'budget');
      },
    });
    const body = { session: 's1', goal: '', step: 1, maxSteps: 5, allowRisky: false, since: 0, snapshot: page, history: [], reported: [] };
    expect(await statusOf(() => h.get('/autopilot/turn')!({ body }))).toBe(402);
  });

  describe('in the studio', () => {
    const notes: string[] = [];
    const opened: string[] = [];
    const host = {
      bridge: { session: async () => true, explore: async () => page, replay: async () => ({ ok: true }) },
      connected: () => true,
      connections: () => 1,
      appUrl: () => page.url,
      enterUse: () => () => undefined,
      show: () => undefined,
      point: () => undefined,
      openReport: (id: string) => opened.push(id),
      notify: (t: string) => notes.push(t),
    } as unknown as AutopilotHost;
    beforeEach(() => {
      calls.length = 0;
      notes.length = 0;
      opened.length = 0;
      vi.stubGlobal('location', { origin: 'http://localhost:7357' });
    });
    afterEach(() => {
      refuse.ready = null;
      refuse.turn = null;
      vi.unstubAllGlobals();
    });

    describe('with “Let it delete, pay, send and sign out” off', () => {
      const turn = (action: object) => ({ thought: 'next', action, findings: [] });
      const steps: { locator: string; step?: { guard?: boolean } }[] = [];
      let blocked: string[] = [];
      const refusing: string[] = [];
      let onShow = () => undefined as void;
      const acting = {
        ...host,
        bridge: {
          session: async () => true,
          explore: async () => ({ ...page, blocked: blocked.splice(0) }),
          replay: async (locator: string, step?: { guard?: boolean }) => {
            if (!step) onShow();
            else {
              steps.push({ locator, step });
              blocked = refusing.splice(0);
            }
            return { ok: true, info: { tag: 'button' } };
          },
        },
      } as unknown as AutopilotHost;
      beforeEach(() => {
        steps.length = 0;
        refuse.posted.length = 0;
        refuse.turns.length = 0;
        onShow = () => undefined;
      });

      it('has the page refuse what would delete, pay, send or sign out, and lists what it left alone as skipped steps', async () => {
        refuse.turns.push(turn({ kind: 'click', control: 2 }), turn({ kind: 'click', control: 3 }), turn({ kind: 'goto', value: '/logout' }), turn({ kind: 'done' }));
        refusing.push('a DELETE request to /api/coupon');
        await new Autopilot(acting).run({ goal: '', maxSteps: 5, allowRisky: false });
        // Apply was clicked, armed; Pay was never clicked.
        expect(steps).toEqual([{ locator: "page.getByRole('button', { name: 'Apply' })", step: { kind: 'click', guard: true } }]);
        const skipped = refuse.posted.filter((p) => p.path === '/sessions/s1/studio-events').map((p) => (p.body as { events: { did: string }[] }).events[0].did);
        expect(skipped).toEqual([
          'Stopped in the page: a DELETE request to /api/coupon (not allowed)',
          'Skipped “Pay $98.00” (not allowed: it says “Pay”)',
          'Skipped opening /logout (not allowed: its address says “logout”)',
        ]);
      }, 15_000);

      it('stops before the next action when Stop is pressed while a control is being shown', async () => {
        refuse.turns.push(turn({ kind: 'click', control: 2 }), turn({ kind: 'click', control: 2 }));
        const run = new Autopilot(acting);
        onShow = () => run.stop();
        await run.run({ goal: '', maxSteps: 5, allowRisky: false });
        expect(steps).toEqual([]);
        expect(refuse.posted.filter((p) => p.path === '/autopilot/turn')).toHaveLength(1);
        refuse.turns.length = 0;
      }, 15_000);
    });

    it('creates no session when the budget is used up', async () => {
      refuse.ready = { status: 402, message: 'The AI budget is used up. Raise the limit or reset the count in Settings → AI to carry on.' };
      await new Autopilot(host).run({ goal: '', maxSteps: 5, allowRisky: false });
      expect(calls.some((c) => c.path === '/sessions')).toBe(false);
      expect(notes).toEqual(['Autopilot couldn’t start: The AI budget is used up. Raise the limit or reset the count in Settings → AI to carry on.']);
      expect(opened).toEqual([]);
    });

    it('leaves no empty session when its first turn is refused', async () => {
      refuse.turn = { status: 402, message: 'The AI budget is used up.' };
      await new Autopilot(host).run({ goal: '', maxSteps: 5, allowRisky: false });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /autopilot/ready', 'POST /sessions', 'POST /autopilot/turn', 'POST /sessions/s1/stop', 'DELETE /sessions/s1']);
      expect(opened).toEqual([]);
      expect(notes).toEqual(['Autopilot couldn’t start: The AI budget is used up.']);
    });
  });
});
