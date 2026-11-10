import type { Usage } from '../../shared/ai.ts';
import type { RefInfo } from '../../shared/api.ts';
import type { FileEdit } from '../changes.ts';
import type { Project } from '../project.ts';

export interface AgentInput {
  /** What the user said or typed. */
  text: string;
  refs: RefInfo[];
  mode: 'edit' | 'fix';
  pageUrl?: string;
  /** For "fix it" after a narrated bug: the failing test and its error. */
  test?: { path: string; code: string; failure: string };
  /** Work the studio prepared, longer than anything said: findings and suggestions from a test session's report. */
  brief?: string;
}

export type AgentOutput =
  | { kind: 'change'; title: string; summary: string; edits: FileEdit[] }
  | { kind: 'answer'; text: string };

export interface AgentContext {
  project: Project;
  /** Short progress updates for the UI, e.g. ("Reading", "src/lib/pricing.ts"). */
  progress: (step: string, detail?: string) => void;
  signal?: AbortSignal;
}

export type AgentErrorCode = 'no-key' | 'auth' | 'rate' | 'network' | 'refused' | 'invalid' | 'aborted' | 'budget' | 'other';

export class AgentError extends Error {
  /** What the provider said it used before the call failed (a stream's first counts), when it said. */
  partial?: Usage;
  /** The provider got the request and may have billed it (Stop, silence or a broken connection after it was sent). */
  sent?: boolean;

  constructor(
    message: string,
    public code: AgentErrorCode,
  ) {
    super(message);
  }
}

export interface AgentProvider {
  readonly source: 'ai' | 'claude' | 'fake';
  readonly model: string;
  run(input: AgentInput, ctx: AgentContext): Promise<AgentOutput>;
}
