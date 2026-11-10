/**
 * Gemini through the Gemini API (a key from Google AI Studio). The model's
 * turns are sent back exactly as they came (their thought signatures carry its
 * reasoning between steps). Long prompts are cached by Gemini automatically.
 */
import { AgentError } from '../types.ts';
import { count, jsonSchemaOf, lostWhileAnswering, said, stream, type ChatModel, type ChatRequest, type ChatResult, type Msg, type ToolCall } from './types.ts';

interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
}

interface GContent {
  role: 'user' | 'model';
  parts: GPart[];
}

/**
 * A streamed answer's chunks as one response: parts in the order they came (each keeps its thought signature),
 * the last finish reason, usage and model version.
 */
function assemble(chunks: GResponse[]): GResponse {
  const parts: GPart[] = [];
  const out: GResponse = {};
  for (const c of chunks) {
    const cand = c.candidates?.[0];
    if (cand?.content?.parts) parts.push(...cand.content.parts);
    if (cand?.finishReason) out.candidates = [{ finishReason: cand.finishReason }];
    if (c.promptFeedback) out.promptFeedback = c.promptFeedback;
    if (c.usageMetadata) out.usageMetadata = c.usageMetadata;
    if (c.modelVersion) out.modelVersion = c.modelVersion;
    if (c.error) out.error = c.error;
  }
  // Text that came in pieces is one part again, as a single answer would have it (a signature stays where it was).
  const merged: GPart[] = [];
  for (const p of parts) {
    const prev = merged.at(-1);
    const plain = (x: GPart) => typeof x.text === 'string' && Object.keys(x).every((k) => k === 'text' || k === 'thought');
    if (prev && plain(prev) && plain(p) && !!prev.thought === !!p.thought) merged[merged.length - 1] = { ...prev, text: prev.text! + p.text! };
    else merged.push({ ...p });
  }
  out.candidates = [{ ...out.candidates?.[0], content: { role: 'model', parts: merged } }];
  return out;
}

interface GResponse {
  error?: { message?: string; status?: string };
  candidates?: { content?: GContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number };
}

function encode(messages: Msg[]): GContent[] {
  return messages.map((m): GContent => {
    if (m.role === 'user') return { role: 'user', parts: m.parts.map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mime, data: p.data } })) };
    if (m.role === 'assistant') {
      if (m.raw && typeof m.raw === 'object' && Array.isArray((m.raw as GContent).parts)) return m.raw as GContent;
      return { role: 'model', parts: [...(m.text ? [{ text: m.text }] : []), ...m.calls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args } }))] };
    }
    return { role: 'user', parts: m.results.map((r) => ({ functionResponse: { id: r.id, name: r.name, response: r.error ? { error: r.output } : { output: r.output } } })) };
  });
}

const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']);

export class GeminiModel implements ChatModel {
  readonly kind = 'gemini' as const;
  readonly vision = true;

  constructor(
    readonly model: string,
    private key: () => string | undefined,
    private baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const key = this.key();
    if (!key) throw new AgentError('No Gemini API key yet. Add one in Settings → AI.', 'no-key');
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: encode(req.messages),
      ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] } : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        ...(req.effort ? { thinkingConfig: { thinkingLevel: req.effort.toUpperCase() } } : {}),
        ...(req.json ? { responseMimeType: 'application/json', responseJsonSchema: jsonSchemaOf(req.json.schema) } : {}),
      },
    };
    // Streamed, so a long answer is never cut by a time limit (only silence is).
    const chunks: GResponse[] = [];
    const out = await stream('Gemini', `${this.baseUrl}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`, { 'x-goog-api-key': key }, body, req.signal, (c) => void chunks.push(c as GResponse));
    const whole = out.whole as GResponse | GResponse[] | undefined;
    if (!whole && !chunks.length) throw lostWhileAnswering('Gemini');
    const res = assemble(whole ? (Array.isArray(whole) ? whole : [whole]) : chunks);
    if (res.error) throw new AgentError(`Gemini couldn’t answer${res.error.message ? `: ${said(res.error.message)}` : ''}.`, 'other');

    const cand = res.candidates?.[0];
    const content: GContent = cand?.content ?? { role: 'model', parts: [] };
    const text: string[] = [];
    const calls: ToolCall[] = [];
    content.parts?.forEach((p, i) => {
      if (p.text && !p.thought) text.push(p.text);
      if (p.functionCall) calls.push({ id: p.functionCall.id ?? `call_${i}_${p.functionCall.name}`, name: p.functionCall.name, args: p.functionCall.args ?? {} });
    });
    const u = res.usageMetadata ?? {};
    const cacheRead = count(u.cachedContentTokenCount);
    const reason = cand?.finishReason;
    return {
      text: text.join('').trim(),
      calls,
      stop: res.promptFeedback?.blockReason || (reason && BLOCKED.has(reason)) ? 'refusal' : reason === 'MAX_TOKENS' ? 'length' : calls.length ? 'tools' : 'end',
      usage: {
        input: Math.max(0, count(u.promptTokenCount) + count(u.toolUsePromptTokenCount) - cacheRead),
        output: count(u.candidatesTokenCount) + count(u.thoughtsTokenCount),
        cacheRead,
        cacheWrite: 0,
        reasoning: count(u.thoughtsTokenCount),
      },
      model: res.modelVersion ?? this.model,
      raw: { role: 'model', parts: content.parts ?? [] },
    };
  }
}
