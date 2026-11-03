/**
 * Enter in a form's field submits it, and the browser follows with a click of its own on the submit button. Recorded
 * as a step, that click fails the generated test (the button is gone once the form is sent), so it is left out.
 */
import { describe, expect, it } from 'vitest';
import { isEnterSubmitClick, type ClickFacts } from '../src/bridge/forms';

// What Chromium does after Enter in the coupon field: a click with no pointer, on the form's submit button, at once.
const afterEnter: ClickFacts = { detail: 0, submits: true, sameForm: true, sinceEnter: 0.3 };

describe('the click the browser makes when Enter submits a form', () => {
  it('is recognised, so only the Enter becomes a step', () => {
    expect(isEnterSubmitClick(afterEnter)).toBe(true);
  });

  it('is never a click the person made with the mouse', () => {
    expect(isEnterSubmitClick({ ...afterEnter, detail: 1 })).toBe(false);
  });

  it('is only on the submit button of the form Enter was pressed in', () => {
    expect(isEnterSubmitClick({ ...afterEnter, submits: false })).toBe(false);
    expect(isEnterSubmitClick({ ...afterEnter, sameForm: false })).toBe(false);
  });

  it('comes right after the Enter: a later click from the keyboard is the person’s', () => {
    expect(isEnterSubmitClick({ ...afterEnter, sinceEnter: 2500 })).toBe(false);
    expect(isEnterSubmitClick({ ...afterEnter, sinceEnter: -5 })).toBe(false);
  });
});
