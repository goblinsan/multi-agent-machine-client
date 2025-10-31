import { logger } from "../../logger.js";
import { createDashboardTaskEntriesWithSummarizer, findTaskIdByExternalId } from "../../tasks/taskManager.js";
import { TaskAPI } from "../../dashboard/TaskAPI.js";
import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult } from "../../agents/persona.js";
import { PERSONAS } from "../../personaNames.js";

const taskAPI = new TaskAPI();

export const STAGE_POLICY: Record<string, { immediate: boolean; initialStatus: string; assignTo?: string }> = {
  qa: { immediate: true, initialStatus: "in_progress", assignTo: PERSONAS.IMPLEMENTATION_PLANNER },
  devops: { immediate: true, initialStatus: "in_progress", assignTo: PERSONAS.DEVOPS },
  "code-review": { immediate: false, initialStatus: "backlog", assignTo: PERSONAS.CODE_REVIEWER },
  security: { immediate: false, initialStatus: "backlog", assignTo: PERSONAS.SECURITY_REVIEW }
};

type MiniCycleOptions = {
  repo?: string;
  branch?: string;
  projectId?: string | null;
  milestoneDescriptor?: any;
  parentTaskDescriptor?: any;
  projectName?: string | null;
  scheduleHint?: string;
  qaResult?: any;
};

// Handle failure mini-cycle for QA/DevOps/Code-Review/Security
// suggestedTasks: array of suggestion objects returned by PM or persona
export async function handleFailureMiniCycle(r: any, workflowId: string, stage: string, suggestedTasks: any[], options: MiniCycleOptions) {
  const policy = STAGE_POLICY[stage] || { immediate: false, initialStatus: "backlog" };
  if (!Array.isArray(suggestedTasks)) suggestedTasks = [];

  if (!suggestedTasks.length) {
    logger.info("handleFailureMiniCycle: no suggested tasks", { workflowId, stage });
    return { created: [] as any[], forwarded: false };
  }

  // For immediate stages we create tasks with initial_status from policy and block until creation+status OK
  try {
    const createOpts = {
      stage: stage as any,
      milestoneDescriptor: options.milestoneDescriptor || null,
      parentTaskDescriptor: options.parentTaskDescriptor || null,
      projectId: options.projectId || null,
      projectName: options.projectName || null,
      scheduleHint: options.scheduleHint
    };

    // Use the existing summarizer-before-create wrapper
    const created = await createDashboardTaskEntriesWithSummarizer(r, workflowId, suggestedTasks, createOpts as any);

    // If policy requires immediate visibility, ensure status is set to policy.initialStatus
    if (policy.immediate && Array.isArray(created) && created.length) {
      for (const c of created) {
        try {
          let key: string | null = null;
          // Prefer a concrete created id when available
          if (c.createdId) key = String(c.createdId);
          // Otherwise resolve by external id within the project, then fall back to by-external
          else if (c.externalId && options.projectId) {
            key = (await findTaskIdByExternalId(c.externalId, options.projectId)) || String(c.externalId);
          } else if (c.externalId) {
            key = String(c.externalId);
          }

          if (key) {
            await taskAPI.updateTaskStatus(String(key), policy.initialStatus, options.projectId || undefined).catch((err) => {
              logger.warn("handleFailureMiniCycle: updateTaskStatus failed", { workflowId, stage, key, error: err });
              throw err;
            });
          } else {
            logger.warn("handleFailureMiniCycle: could not determine created task id", { workflowId, stage, created: c });
          }
        } catch (err) {
          logger.error("handleFailureMiniCycle: failed to set status for created task", { workflowId, stage, error: err });
          throw err;
        }
      }
    }

    // Forward created tasks to implementation planner for immediate stages
    let plannerResult: any = null;
    if (policy.immediate && created.length) {
      logger.debug('handleFailureMiniCycle created', { created });
      const implPersona = (policy.assignTo && policy.assignTo.length) ? policy.assignTo : (PERSONAS.IMPLEMENTATION_PLANNER);
      try {
        const corr = (await import("crypto")).randomUUID();
        logger.info('handleFailureMiniCycle sending to planner', { workflowId, stage, corr, implPersona });
        await sendPersonaRequest(r, {
          workflowId,
          toPersona: implPersona,
          step: `${stage}-created-tasks`,
          intent: "handle_created_followups",
          // include created tasks and any QA payload forwarded via options (if present)
          payload: { created_tasks: created, stage, milestone: options.milestoneDescriptor, parent_task: options.parentTaskDescriptor, qa_result: (options as any).qaResult ?? null },
          corrId: corr,
          repo: options.repo,
          branch: options.branch,
          projectId: options.projectId ?? undefined
        });
        logger.info("handleFailureMiniCycle dispatched created tasks to planner", { workflowId, stage, corr, implPersona });

        // Block and wait for planner to finish handling created tasks
        let plannerEvent;
        try {
          logger.info("handleFailureMiniCycle waiting for planner completion", { workflowId, stage, corr, implPersona });
          plannerEvent = await waitForPersonaCompletion(r, implPersona, workflowId, corr);
          logger.info("handleFailureMiniCycle received planner completion", { workflowId, stage, corr, implPersona, eventId: plannerEvent?.id });
        } catch (err) {
          logger.error("handleFailureMiniCycle waitForPersonaCompletion failed", { workflowId, stage, corr, implPersona, error: String(err) });
          throw err;
        }
        try {
          plannerResult = parseEventResult(plannerEvent.fields.result);
        } catch (err) {
          logger.warn("handleFailureMiniCycle: planner returned unparsable result", { workflowId, stage, error: err });
          plannerResult = plannerEvent.fields.result;
        }
      } catch (err) {
        logger.warn("handleFailureMiniCycle: failed to forward created tasks to planner or planner failed", { workflowId, stage, error: err });
        throw err;
      }
    }

    return { created, forwarded: policy.immediate, plannerResult };
  } catch (err) {
    logger.error("handleFailureMiniCycle: exception", { workflowId, stage, error: err });
    throw err;
  }
}

export default { STAGE_POLICY, handleFailureMiniCycle };
