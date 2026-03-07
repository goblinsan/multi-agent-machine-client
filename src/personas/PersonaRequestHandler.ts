import { logger } from "../logger.js";
import { callLMStudio } from "../lmstudio.js";

export type ChatMessage = { role: "system" | "user"; content: string };

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
    extraSystemMessages,
  } = input;

  const systemParts: string[] = [systemPrompt];

  if (scanSummaryForPrompt && scanSummaryForPrompt.length) {
    const label =
      labelForScanSummary && labelForScanSummary.trim().length
        ? labelForScanSummary
        : "File scan summary";
    systemParts.push(`${label}:\n${scanSummaryForPrompt}`);
  }

  if (dashboardContext && dashboardContext.trim().length) {
    systemParts.push(`Dashboard context (may be stale):\n${dashboardContext}`);
  }

  if (qaHistory && qaHistory.trim().length) {
    systemParts.push(
      `Latest QA Test Results:\n${qaHistory}\n\nUse this to understand what failed in previous attempts and adjust your plan accordingly.`,
    );
  }

  if (planningHistory && planningHistory.trim().length) {
    systemParts.push(
      `Previous Planning Iterations:\n${planningHistory}\n\nYou have created plans before for this task. Review the previous planning attempts above, consider what may have changed (new context, QA results, etc.), and either:\n1. Use the existing plan if it's still valid and complete\n2. Refine and improve the plan based on new information\n3. Create a new plan if requirements have changed significantly\n\nBe clear about whether you're reusing, refining, or replacing the previous plan.`,
    );
  }

  if (Array.isArray(promptFileSnippets) && promptFileSnippets.length) {
    const snippetParts: string[] = [
      "Existing project files for reference (read-only):",
    ];
    for (const snippet of promptFileSnippets) {
      snippetParts.push(`File: ${snippet.path}`);
      snippetParts.push("```");
      snippetParts.push(snippet.content);
      snippetParts.push("```");
    }
    systemParts.push(snippetParts.join("\n"));
  }

  if (Array.isArray(extraSystemMessages) && extraSystemMessages.length) {
    for (const msg of extraSystemMessages) {
      if (msg && msg.trim().length) systemParts.push(msg);
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: userText },
  ];

  logger.debug("PersonaRequestHandler: built messages", {
    persona,
    systemCount: 1,
  });
  return messages;
}

export type CallModelInput = {
  persona: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs?: number;
};

export async function callPersonaModel(
  input: CallModelInput,
): Promise<{ content: string; duration_ms: number }> {
  const { persona, model, messages, timeoutMs } = input;
  const started = Date.now();
  try {
    const resp = await callLMStudio(model, messages as any, 0.2, { timeoutMs });
    const duration_ms = Date.now() - started;
    const preview =
      resp.content && resp.content.length > 4000
        ? resp.content.slice(0, 4000) + "... (truncated)"
        : resp.content;
    logger.info("persona response", { persona, preview });
    return { content: resp.content, duration_ms };
  } catch (e: any) {
    const duration_ms = Date.now() - started;
    logger.error("PersonaRequestHandler: LM call failed", {
      persona,
      error: e?.message || String(e),
      duration_ms,
    });
    throw e;
  }
}
