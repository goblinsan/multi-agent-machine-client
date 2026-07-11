import { logger } from "../logger.js";
import { cfg } from "../config.js";
import { callLMStudio, ResponseFormat } from "../lmstudio.js";

export type ChatMessage = { role: "system" | "user"; content: string };

const TRIM_MARKER = "\n... [trimmed to fit prompt budget]";

function truncateSection(section: string, maxChars: number): string {
  if (section.length <= maxChars) return section;
  const keep = Math.max(0, maxChars - TRIM_MARKER.length);
  return section.slice(0, keep) + TRIM_MARKER;
}

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

  const budget = cfg.personaPromptMaxChars;
  const fixedChars = systemPrompt.length + userText.length;
  let totalChars =
    fixedChars +
    systemParts
      .slice(1)
      .reduce((sum, section) => sum + section.length, 0);

  if (Number.isFinite(budget) && budget > 0 && totalChars > budget) {
    const overBudgetBy = totalChars - budget;
    const trimmable = systemParts
      .map((section, index) => ({ section, index }))
      .slice(1)
      .sort((a, b) => b.section.length - a.section.length);

    let remainingToTrim = overBudgetBy;
    for (const entry of trimmable) {
      if (remainingToTrim <= 0) break;
      const original = systemParts[entry.index];
      const target = Math.max(2000, original.length - remainingToTrim);
      if (target >= original.length) continue;
      systemParts[entry.index] = truncateSection(original, target);
      remainingToTrim -= original.length - systemParts[entry.index].length;
    }

    const trimmedTotal =
      fixedChars +
      systemParts.slice(1).reduce((sum, section) => sum + section.length, 0);
    logger.warn("Persona prompt exceeded budget - trimmed context sections", {
      persona,
      budget,
      beforeChars: totalChars,
      afterChars: trimmedTotal,
      estimatedTokens: Math.round(trimmedTotal / 4),
    });
    totalChars = trimmedTotal;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: userText },
  ];

  logger.debug("PersonaRequestHandler: built messages", {
    persona,
    systemCount: 1,
    promptChars: totalChars,
    estimatedTokens: Math.round(totalChars / 4),
  });
  return messages;
}

export type CallModelInput = {
  persona: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs?: number;
  responseFormat?: ResponseFormat;
};

export async function callPersonaModel(
  input: CallModelInput,
): Promise<{ content: string; duration_ms: number; truncated: boolean }> {
  const { persona, model, messages, timeoutMs, responseFormat } = input;
  const started = Date.now();
  try {
    const resp = await callLMStudio(model, messages as any, 0.2, {
      timeoutMs,
      responseFormat,
    });
    const duration_ms = Date.now() - started;
    const truncated = resp.finishReason === "length";
    if (truncated) {
      logger.warn("persona response truncated at the output token limit", {
        persona,
        contentLength: resp.content.length,
      });
    }
    const preview =
      resp.content && resp.content.length > 4000
        ? resp.content.slice(0, 4000) + "... (truncated)"
        : resp.content;
    logger.info("persona response", { persona, preview });
    return { content: resp.content, duration_ms, truncated };
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
