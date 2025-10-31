import { logger } from '../logger.js';
import { callLMStudio } from '../lmstudio.js';

export type ChatMessage = { role: 'system' | 'user'; content: string };

export type BuildMessagesInput = {
  persona: string;
  systemPrompt: string;
  userText: string;
  scanSummaryForPrompt?: string | null;
  labelForScanSummary?: string;
  dashboardContext?: string | null;
  qaHistory?: string | null;
  planningHistory?: string | null;
  promptFileSnippets?: Array<{ path: string; content: string }>;
  extraSystemMessages?: string[];
};

export function buildPersonaMessages(input: BuildMessagesInput): ChatMessage[] {
  const {
    persona,
    systemPrompt,
    userText,
    scanSummaryForPrompt,
    labelForScanSummary,
    dashboardContext,
    qaHistory,
    planningHistory,
    promptFileSnippets,
    extraSystemMessages
  } = input;

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  if (scanSummaryForPrompt && scanSummaryForPrompt.length) {
    const label = labelForScanSummary && labelForScanSummary.trim().length
      ? labelForScanSummary
      : 'File scan summary';
    messages.push({ role: 'system', content: `${label}:
${scanSummaryForPrompt}` });
  }

  if (dashboardContext && dashboardContext.trim().length) {
    messages.push({ role: 'system', content: `Dashboard context (may be stale):
${dashboardContext}` });
  }

  if (qaHistory && qaHistory.trim().length) {
    messages.push({
      role: 'system',
      content: `Latest QA Test Results:
${qaHistory}

Use this to understand what failed in previous attempts and adjust your plan accordingly.`
    });
  }

  if (planningHistory && planningHistory.trim().length) {
    messages.push({
      role: 'system',
      content: `Previous Planning Iterations:
${planningHistory}

You have created plans before for this task. Review the previous planning attempts above, consider what may have changed (new context, QA results, etc.), and either:
1. Use the existing plan if it's still valid and complete
2. Refine and improve the plan based on new information
3. Create a new plan if requirements have changed significantly

Be clear about whether you're reusing, refining, or replacing the previous plan.`
    });
  }

  if (Array.isArray(promptFileSnippets) && promptFileSnippets.length) {
    const snippetParts: string[] = ['Existing project files for reference (read-only):'];
    for (const snippet of promptFileSnippets) {
      snippetParts.push(`File: ${snippet.path}`);
      snippetParts.push('```');
      snippetParts.push(snippet.content);
      snippetParts.push('```');
    }
    messages.push({ role: 'system', content: snippetParts.join('\n') });
  }

  if (Array.isArray(extraSystemMessages) && extraSystemMessages.length) {
    for (const msg of extraSystemMessages) {
      if (msg && msg.trim().length) messages.push({ role: 'system', content: msg });
    }
  }

  messages.push({ role: 'user', content: userText });

  logger.debug('PersonaRequestHandler: built messages', { persona, systemCount: messages.filter(m => m.role === 'system').length });
  return messages;
}

export type CallModelInput = {
  persona: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs?: number;
};

export async function callPersonaModel(input: CallModelInput): Promise<{ content: string; duration_ms: number }>{
  const { persona, model, messages, timeoutMs } = input;
  const started = Date.now();
  try {
    const resp = await callLMStudio(model, messages as any, 0.2, { timeoutMs });
    const duration_ms = Date.now() - started;
    const preview = resp.content && resp.content.length > 4000 ? resp.content.slice(0, 4000) + '... (truncated)' : resp.content;
    logger.info('persona response', { persona, preview });
    return { content: resp.content, duration_ms };
  } catch (e: any) {
    const duration_ms = Date.now() - started;
    logger.error('PersonaRequestHandler: LM call failed', { persona, error: e?.message || String(e), duration_ms });
    throw e;
  }
}
