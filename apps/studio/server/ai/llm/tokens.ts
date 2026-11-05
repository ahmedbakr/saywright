/**
 * How many tokens a request sends, counted before it is sent so a budget set to stop can hold the most it may cost.
 * Measured against Claude's own count (Opus, Sonnet and Haiku count alike), each kind of text is counted at what it
 * costs at most: plain words, code and its symbols, numbers, strings that look random (keys, hashes, base64) a token
 * a character, each script at its own rate, and a picture by its size in pixels as Claude bills it. It stays an
 * estimate: a model seen to send more than estimated has its later requests counted that much bigger (AiService).
 */
import type { Msg, ToolDef } from './types.ts';

/** A run of letters and digits long enough to be a key, hash or encoded data, which tokenizers split nearly a character at a time. */
const BLOB = /[A-Za-z0-9+/=_-]{40,}/g;

/** Tokens for a piece of text: generous for every kind measured (prose, code, CSS, JSON, numbers, scripts, emoji). */
export function textTokens(s: string): number {
  let t = 0;
  const rest = s.replace(BLOB, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? ((t += m.length), ' ') : m));
  let letters = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      letters++;
      continue;
    }
    // A word: a token for every two or three letters, a short one a token.
    if (letters) t += Math.ceil(letters / 2.7);
    letters = 0;
    if (c >= 48 && c <= 57) t += 0.8;
    else if (c === 32) t += 0.3;
    else if (c === 10 || c === 9 || c === 13) t += 0.5;
    else if (c < 0x80) t += 1;
    // Emoji and other characters beyond the first plane, per half.
    else if (c >= 0xd800 && c <= 0xdfff) t += 1.5;
    // Accented Latin, Greek and Cyrillic.
    else if (c < 0x250 || (c >= 0x370 && c < 0x530)) t += 0.5;
    // Arabic, Hebrew and the rest written in two bytes.
    else if (c < 0x800) t += 0.9;
    // Chinese, Japanese, Korean, Hindi…
    else t += 1.2;
  }
  if (letters) t += Math.ceil(letters / 2.7);
  return t;
}

/** The pixel size of a JPEG or PNG image from its first bytes, or null when it can't be read. */
export function imageSize(base64: string): { w: number; h: number } | null {
  const b = Buffer.from(base64.slice(0, 87_384), 'base64');
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  // A JPEG's segments, to the frame header that holds its size.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** The most a picture costs (Claude's limit for one). */
const MOST_PER_IMAGE = 4784;

/** A picture's tokens at Claude's rate: one for each 28-pixel square once it fits 2576 pixels, and a few more. */
export function imageTokens(base64: string): number {
  const size = imageSize(base64);
  if (!size || !size.w || !size.h) return MOST_PER_IMAGE;
  const fit = Math.min(1, 2576 / Math.max(size.w, size.h));
  return Math.min(MOST_PER_IMAGE, Math.ceil((size.w * fit) / 28) * Math.ceil((size.h * fit) / 28) + 16);
}

/**
 * What a model's own turn holds in place of its reasoning (Claude's signature, OpenAI's encrypted reasoning, Gemini's
 * thought signature): sent back with the turn and billed as the reasoning it stands for, which takes about two of its
 * characters a token.
 */
const SEALED = new Set(['signature', 'encrypted_content', 'thoughtSignature']);

function turnTokens(raw: unknown): number {
  let sealed = 0;
  const rest = JSON.stringify(raw, function (this: { type?: unknown }, key: string, value: unknown) {
    if (typeof value === 'string' && (SEALED.has(key) || (key === 'data' && this.type === 'redacted_thinking'))) {
      sealed += value.length;
      return '';
    }
    return value;
  });
  return textTokens(rest ?? '') + sealed / 2;
}

/** What a provider adds to a request that offers tools: its own instructions for using them (Claude's take 365 tokens). */
const TOOL_PROMPT = 400;

/**
 * What an answer's schema adds: it is sent compiled, which Claude counts at about twice its text, with instructions
 * for it (180 tokens).
 */
const schemaTokens = (schema: unknown) => textTokens(JSON.stringify(schema) ?? '') * 1.3 + 250;

/**
 * About how many tokens a request sends, counted so a budget is never short: its text, pictures and the model's own
 * turns sent back as above, the tools and the answer's schema as the provider sends them, and what each message adds.
 */
export function inputTokens(req: { system: string; messages: Msg[]; tools?: ToolDef[]; schema?: unknown }): number {
  let t = textTokens(req.system);
  for (const m of req.messages) {
    if (m.role === 'user') for (const part of m.parts) t += part.type === 'text' ? textTokens(part.text) : imageTokens(part.data);
    // What is sent back: the provider's own form of the turn when there is one.
    else if (m.role === 'assistant') t += m.raw !== undefined ? turnTokens(m.raw) : textTokens(m.text + JSON.stringify(m.calls));
    else for (const r of m.results) t += textTokens(r.output);
  }
  if (req.tools?.length) t += textTokens(JSON.stringify(req.tools)) + TOOL_PROMPT;
  if (req.schema !== undefined) t += schemaTokens(req.schema);
  return Math.ceil(t) + 20 * req.messages.length + 50;
}
