/**
 * What the coding agent is told about answering in words: a question, or a request that needs no change, gets a
 * short paragraph, not a page of bullet points.
 */
import { describe, expect, it } from 'vitest';
import { systemPrompt } from '../../server/ai/context';
import { tempShop } from './helpers';

describe('a plain answer', () => {
  const prompt = systemPrompt(tempShop());

  it('is at most four short sentences, for a question and for a request that is already done', () => {
    const rule = prompt.split('\n').find((l) => l.includes('four short sentences')) ?? '';
    expect(rule).toMatch(/question/);
    expect(rule).toMatch(/already done or needs nothing/);
    expect(rule).toMatch(/won't do/);
  });

  it('is one paragraph that cites files as path:line, without lists or headings', () => {
    expect(prompt).toContain('in one paragraph: no lists, headings or bold');
    expect(prompt).toContain('Cite files as path:line');
  });
});
