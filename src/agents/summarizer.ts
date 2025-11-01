import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult } from "./persona.js";
import { randomUUID } from "crypto";
import { logger } from "../logger.js";
import { PERSONAS } from "../personaNames.js";

export type SummarizeOptions = {
  concise?: boolean;
  maxTokens?: number;
  persona?: string;
};


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
      
      projectId: (task && (task.project_id || task.projectId)) ? String(task.project_id || task.projectId) : undefined,
      corrId: corr
    });

    const event = await waitForPersonaCompletion(r, persona, workflowId, corr);
    const res = parseEventResult(event.fields.result);
    
    const summary = res?.payload?.summary ?? res?.payload?.condensed ?? res?.payload ?? res;
    if (typeof summary === 'object') {
      
      return (summary.text || summary.summary || summary.condensed || JSON.stringify(summary));
    }
    return String(summary || '');
  } catch (err) {
    logger.warn('summarizeTask failed, falling back to original description', { err, task });
    return task?.description ?? task?.summary ?? task?.name ?? '';
  }
}

export default { summarizeTask };



