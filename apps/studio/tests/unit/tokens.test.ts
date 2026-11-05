/**
 * What a request is estimated to send, before it is sent, is never less than what Claude counts for it: each kind of
 * text measured with Claude's token counting API (prose, code, CSS, JSON, ids, random strings, Arabic, Chinese,
 * Russian, Hindi, emoji), pictures by their size, and a model's sealed reasoning sent back with its turn.
 */
import { describe, expect, it } from 'vitest';
import { imageSize, imageTokens, inputTokens, textTokens } from '../../server/ai/llm/tokens';
import { SAMPLES } from './token-samples';

/** What Claude counted for each sample (Opus 5.5, Sonnet 5.5 and Haiku 5.5 alike). */
const COUNTED: Record<string, number> = { prose: 1260, code: 5939, css: 4019, json: 2832, ids: 4969, base64: 4000, hex: 1334, symbols: 3000, arabic: 1290, chinese: 840, russian: 540, hindi: 1056, emoji: 1800 };

/** The first bytes of a PNG or a JPEG of this size, which is all that is read of one. */
function png(w: number, h: number): string {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
}
function jpeg(w: number, h: number): string {
  // Start, an APP0 segment, a quantization table, then the frame header with the size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 1)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, sof, Buffer.alloc(32)]).toString('base64');
}

describe('the input estimate', () => {
  it('is never less than Claude counts, for every kind of text measured, and not wildly more', () => {
    for (const [kind, text] of Object.entries(SAMPLES)) {
      const est = textTokens(text);
      expect(est, kind).toBeGreaterThanOrEqual(COUNTED[kind]);
      expect(est / COUNTED[kind], kind).toBeLessThan(2.5);
    }
  });

  it('counts a picture by its size as Claude does: a token for each 28-pixel square, within 2576 pixels, at most 4784', () => {
    expect(imageSize(png(1280, 800))).toEqual({ w: 1280, h: 800 });
    expect(imageSize(jpeg(1920, 1080))).toEqual({ w: 1920, h: 1080 });
    // Claude counted 640, 1336, 2693, 3824 and 2486 for screenshots of these sizes, and 4700 for a retina one.
    const counted: [string, number][] = [[jpeg(800, 600), 640], [jpeg(1280, 800), 1336], [jpeg(1920, 1080), 2693], [jpeg(1170, 2532), 3824], [jpeg(1440, 5000), 2486], [jpeg(2560, 1600), 4700]];
    for (const [img, n] of counted) {
      expect(imageTokens(img)).toBeGreaterThanOrEqual(n);
      expect(imageTokens(img)).toBeLessThan(n * 1.05 + 20);
    }
    // One it can't read is counted at the most a picture costs.
    expect(imageTokens(Buffer.from('GIF89a........').toString('base64'))).toBe(4784);
  });

  it('counts a model’s sealed reasoning at what it stands for, and random-looking text a token a character', () => {
    const sealed = 'A'.repeat(3000).replace(/A/g, (_, i: number) => 'Zq9+'[i % 4]);
    const turn = (raw: unknown) => inputTokens({ system: '', messages: [{ role: 'assistant', text: '', calls: [], raw }] });
    const empty = turn([{ type: 'thinking', thinking: '', signature: '' }]);
    // Claude: about 790 characters of signature plus two for each token of reasoning; OpenAI and Gemini alike.
    expect(turn([{ type: 'thinking', thinking: '', signature: sealed }]) - empty).toBe(1500);
    expect(turn([{ type: 'redacted_thinking', data: sealed }]) - turn([{ type: 'redacted_thinking', data: '' }])).toBe(1500);
    expect(turn([{ type: 'reasoning', encrypted_content: sealed }]) - turn([{ type: 'reasoning', encrypted_content: '' }])).toBe(1500);
    // The same characters anywhere else (a file with a key or base64 in it) are a token each.
    const read = (output: string) => inputTokens({ system: '', messages: [{ role: 'tool', results: [{ id: 'r', name: 'read_file', output }] }] });
    expect(read(sealed) - read('')).toBeGreaterThanOrEqual(3000);
    expect(read(sealed) - read('')).toBeLessThanOrEqual(3001);
  });

  it('adds what tools and a structured answer’s schema cost as the provider sends them', () => {
    const ask = { system: 'You write reports.', messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'The session.' }] }] };
    const plain = inputTokens(ask);
    // Claude counted 225 more for the smallest schema, and 1,109 more for the studio's tools (365 of them its own instructions).
    expect(inputTokens({ ...ask, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }) - plain).toBeGreaterThanOrEqual(225);
    expect(inputTokens({ ...ask, tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }] }) - plain).toBeGreaterThanOrEqual(365);
  });
});
