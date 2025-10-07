import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult } from "./persona.js";
import { randomUUID } from "crypto";
import { logger } from "../logger.js";
import { PERSONAS } from "../personaNames.js";

export type SummarizeOptions = {
  concise?: boolean; // if true, request very brief direct next steps
  maxTokens?: number;
  persona?: string; // persona name to use, default 'summarization'
};

// Summarize a single task description via the summarizer persona. Returns the condensed text.
export async function summarizeTask(r: any, workflowId: string, task: any, options: SummarizeOptions = {}) {
  const corr = randomUUID();
  const persona = options.persona || PERSONAS.SUMMARIZATION;
  const payload = {
    task,
    concise: options.concise ?? true,
    maxTokens: options.maxTokens ?? 200
  };

  try {
    await sendPersonaRequest(r, {
      workflowId,
      toPersona: persona,
      step: 'summarize-task',
      intent: 'condense_task_description',
      payload,
      // Ensure downstream sees project_id even if no repo/branch context is provided
      projectId: (task && (task.project_id || task.projectId)) ? String(task.project_id || task.projectId) : undefined,
      corrId: corr
    });

    const event = await waitForPersonaCompletion(r, persona, workflowId, corr);
    const res = parseEventResult(event.fields.result);
    // Expect res.payload.summary or res.payload.condensed
    const summary = res?.payload?.summary ?? res?.payload?.condensed ?? res?.payload ?? res;
    if (typeof summary === 'object') {
      // if the persona returns rich object, try to pick a string
      return (summary.text || summary.summary || summary.condensed || JSON.stringify(summary));
    }
    return String(summary || '');
  } catch (err) {
    logger.warn('summarizeTask failed, falling back to original description', { err, task });
    return task?.description ?? task?.summary ?? task?.name ?? '';
  }
}

export default { summarizeTask };
// src/agents/summarizer.ts

// This file will contain the logic for interacting with the summarizer agent.
