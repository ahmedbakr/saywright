import type { StatusResponse } from '@shared/api';
import { modelName } from '@shared/models';
import { useStudio } from '@/core/store';

/** What to call the AI that makes changes, in buttons and messages: "Claude", "GPT", "Gemini", or "AI". */
export function aiName(who: StatusResponse['ai']['who'] | null | undefined): string {
  switch (who?.connection) {
    case 'anthropic':
    case 'claude-code':
      return 'Claude';
    case 'openai':
    case 'codex':
      return 'GPT';
    case 'gemini':
    case 'gemini-cli':
      return 'Gemini';
    default:
      return 'AI';
  }
}

export function useAiName(): string {
  return aiName(useStudio((s) => s.status?.ai.who));
}

export { modelName };
