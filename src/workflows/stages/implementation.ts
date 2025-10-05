import { randomUUID } from "crypto";
import { cfg } from "../../config.js";
import { logger } from "../../logger.js";
import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult, interpretPersonaStatus, extractJsonPayloadFromText } from "../../agents/persona.js";
import { updateTaskStatus, fetchProjectStatus } from "../../dashboard.js";
import { firstString, slugify, normalizeRepoPath, ENGINEER_PERSONAS_REQUIRING_PLAN } from "../../util.js";

const MAX_APPROVAL_RETRIES = 10;

type PlanHistoryEntry = {
    attempt: number;
    content: string;
    payload: any;
};

type PlanApprovalOutcome = {
    planText: string;
    planPayload: any;
    planSteps: any[];
    history: PlanHistoryEntry[];
};

function extractPlanSteps(planPayload: any): any[] {
    if (!planPayload || typeof planPayload !== "object") return [];
    if (Array.isArray(planPayload.plan)) return planPayload.plan;
    if (Array.isArray(planPayload.steps)) return planPayload.steps;
    if (Array.isArray(planPayload.items)) return planPayload.items;
    return [];
}

async function runEngineerPlanApproval(r: any, workflowId: string, projectId: string, repoRemote: string, branchName: string, implementationPersona: string, plannerPersona: string, basePayload: Record<string, any>, attempt: number, feedback: string | null): Promise<PlanApprovalOutcome | null> {
    if (!ENGINEER_PERSONAS_REQUIRING_PLAN.has(implementationPersona.toLowerCase())) return null;

    const planner = plannerPersona || implementationPersona;
    const plannerLower = planner.toLowerCase();
    if (!cfg.allowedPersonas.includes(planner)) {
        logger.warn("plan approval persona not allowed", { planner });
    }

    const effectiveMax = Number.isFinite(MAX_APPROVAL_RETRIES) ? MAX_APPROVAL_RETRIES : 10;
    const baseFeedbackText = feedback && feedback.trim().length ? feedback.trim() : "";
    let planFeedbackNotes: string[] = [];
    const planHistory: PlanHistoryEntry[] = [];

    for (let planAttempt = 0; planAttempt < effectiveMax; planAttempt += 1) {
        const feedbackTextParts = [] as string[];
        if (baseFeedbackText.length) feedbackTextParts.push(baseFeedbackText);
        if (planFeedbackNotes.length) feedbackTextParts.push(...planFeedbackNotes);
        const planFeedbackText = feedbackTextParts.length ? feedbackTextParts.join("\n\n") : undefined;

        const planPayload = {
            ...basePayload,
            feedback: baseFeedbackText || undefined,
            plan_feedback: planFeedbackText,
            plan_request: {
                attempt: planAttempt + 1,
                requires_approval: true,
                revision: attempt
            },
            plan_history: planHistory.length ? planHistory.slice() : undefined
        };

        const planCorrId = randomUUID();
        logger.info("coordinator dispatch plan", {
            workflowId,
            targetPersona: planner,
            attempt,
            planAttempt: planAttempt + 1
        });

        await sendPersonaRequest(r, {
            workflowId,
            toPersona: planner,
            step: "2-plan",
            intent: "plan_execution",
            payload: planPayload,
            corrId: planCorrId,
            repo: repoRemote,
            branch: branchName,
            projectId: projectId!
        });

        const planEvent = await waitForPersonaCompletion(r, planner, workflowId, planCorrId);
        const planResultObj = parseEventResult(planEvent.fields.result);
        logger.debug("plan persona result raw", { planner, workflowId, planCorrId, planResultObjPreview: String(planResultObj?.output || '').slice(0, 200) });
        const planOutput = planResultObj?.output || "";
        const planJson = extractJsonPayloadFromText(planOutput) || planResultObj?.payload || null;
        logger.debug("plan persona parsed json", { planner, workflowId, planCorrId, hasPlanJson: !!planJson, planJsonPreview: planJson ? JSON.stringify(planJson).slice(0, 400) : null });
        const planSteps = extractPlanSteps(planJson);

        planHistory.push({ attempt: planAttempt + 1, content: planOutput, payload: planJson });

        if (planSteps.length) {
            logger.info("plan approved", {
                workflowId,
                planner,
                attempt,
                planAttempt: planAttempt + 1,
                steps: planSteps.length
            });
            logger.debug("plan approved payload preview", { workflowId, planner, planAttempt: planAttempt + 1, planStepsPreview: JSON.stringify(planSteps).slice(0, 400) });
            return { planText: planOutput, planPayload: planJson, planSteps, history: planHistory.slice() };
        }

        const issue = planJson && typeof planJson === "object"
            ? "Plan response did not include a non-empty 'plan' array."
            : "Plan response must include JSON with a 'plan' array describing the execution steps.";

        planFeedbackNotes = [
            `${issue} Please respond with JSON containing a 'plan' array (each item should summarize a step and include owners or dependencies) and confirm readiness for approval.`
        ];
        logger.warn("plan approval feedback", {
            workflowId,
            planner,
            attempt,
            planAttempt: planAttempt + 1,
            issue
        });
    }

    throw new Error(`Exceeded plan approval attempts for ${planner} on revision ${attempt}`);
}

export type LeadCycleOutcome = {
    success: boolean;
    details: string;
    output: string;
    commit: any | null;
    paths: string[];
    appliedEdits?: any;
    result?: any;
    noChanges?: boolean;
    plan?: PlanApprovalOutcome | null;
};

export async function runLeadCycle(r: any, workflowId: string, projectId: string, projectInfo: any, projectSlug: string | null, repoRemote: string, branchName: string, baseBranch: string, milestoneDescriptor: any, milestoneName: string, milestoneSlug: string, taskDescriptor: any, taskName: string | null, feedbackNotes: string[], attempt: number): Promise<LeadCycleOutcome> {
    const feedback = feedbackNotes.filter(Boolean).join("\n\n");
    const milestoneNameForPayload = milestoneDescriptor?.name || milestoneName;
    const engineerBasePayload = {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        project_slug: projectSlug || undefined,
        project_name: projectInfo?.name || "",
        milestone: milestoneDescriptor,
        milestone_name: milestoneNameForPayload,
        milestone_slug: milestoneDescriptor?.slug || milestoneSlug,
        task: taskDescriptor,
        task_name: taskName || (taskDescriptor?.name ?? ""),
        goal: feedback || projectInfo?.goal || projectInfo?.direction || milestoneDescriptor?.goal,
        base_branch: baseBranch,
        feedback: feedback || undefined,
        revision: attempt
    };

    const plannerPersona = "lead-engineer";
    const planOutcome = await runEngineerPlanApproval(r, workflowId, projectId, repoRemote, branchName, "lead-engineer", plannerPersona, engineerBasePayload, attempt, feedback || null);

    const leadCorrId = randomUUID();
    logger.info("coordinator dispatch lead", {
        workflowId,
        attempt,
        taskName: taskName,
        milestoneName: milestoneNameForPayload
    });
    const implementationPayload = {
        ...engineerBasePayload,
        approved_plan: planOutcome?.planPayload ?? null,
        approved_plan_steps: planOutcome?.planSteps ?? null,
        plan_text: planOutcome?.planText ?? null,
        plan_history: planOutcome?.history ?? null
    };

    await sendPersonaRequest(r, {
        workflowId,
        toPersona: "lead-engineer",
        step: "2-implementation",
        intent: "implement_milestone",
        payload: implementationPayload,
        corrId: leadCorrId,
        repo: repoRemote,
        branch: branchName,
        projectId: projectId!,
    });

    try {
        let didUpdate = false;
        const candidateExternalId = taskDescriptor?.id || null;
        if (candidateExternalId && projectId) {
            // attempt to find the created id by external id via the dashboard
            const mapped = await (async () => {
                try {
                    const { findTaskIdByExternalId } = await import("../../tasks/taskManager.js");
                    return await findTaskIdByExternalId(String(candidateExternalId), projectId);
                } catch (err) {
                    return null;
                }
            })();
            if (mapped) {
                await updateTaskStatus(mapped, "in_progress").catch(() => { });
                didUpdate = true;
            }
        }

        if (!didUpdate && projectId && taskName) {
            const proj = await fetchProjectStatus(projectId) as any;
            const candidates = Array.isArray(proj?.tasks) ? proj.tasks : (Array.isArray(proj?.task_list) ? proj.task_list : (Array.isArray(proj?.tasks_list) ? proj.tasks_list : []));
            if (Array.isArray(candidates) && candidates.length) {
                const match = candidates.find((t: any) => (t.title || t.name || t.summary || "").toString().toLowerCase() === (taskName || "").toLowerCase());
                if (match && match.id) {
                    await updateTaskStatus(match.id, "in_progress").catch(() => { });
                    didUpdate = true;
                }
            }
        }
    } catch (err) {
        logger.debug("attempt to set task in_progress failed", { workflowId, error: err });
    }

    const leadEvent = await waitForPersonaCompletion(r, "lead-engineer", workflowId, leadCorrId);
    const leadResultObj = parseEventResult(leadEvent.fields.result);
    logger.info("coordinator received lead engineer completion", { workflowId, corrId: leadCorrId, eventId: leadEvent.id });

    const appliedEdits = leadResultObj?.applied_edits;
    if (!appliedEdits || appliedEdits.attempted === false) {
        return { success: false, details: "Lead engineer did not apply edits.", output: leadResultObj?.output || "", commit: null, paths: [], appliedEdits: appliedEdits, result: leadResultObj, plan: planOutcome || undefined };
    }

    const noChanges = !appliedEdits.applied && appliedEdits.reason === "no_changes";
    if (!appliedEdits.applied && !noChanges) {
        const reason = appliedEdits.reason || appliedEdits.error || "unknown";
        return { success: false, details: `Lead edits were not applied (${reason}).`, output: leadResultObj?.output || "", commit: appliedEdits.commit || null, paths: appliedEdits.paths || [], appliedEdits, result: leadResultObj, plan: planOutcome || undefined };
    }

    const commitInfo = appliedEdits.commit || null;
    if (commitInfo && commitInfo.committed === false) {
        const reason = commitInfo.reason || "commit_failed";
        return { success: false, details: `Commit failed (${reason}).`, output: leadResultObj?.output || "", commit: commitInfo, paths: appliedEdits.paths || [], appliedEdits, result: leadResultObj, plan: planOutcome || undefined };
    }
    if (commitInfo && commitInfo.pushed === false && commitInfo.reason) {
        return { success: false, details: `Push failed (${commitInfo.reason}).`, output: leadResultObj?.output || "", commit: commitInfo, paths: appliedEdits.paths || [], appliedEdits, result: leadResultObj, plan: planOutcome || undefined };
    }

    return {
        success: true,
        details: leadResultObj?.output || "",
        output: leadResultObj?.output || "",
        commit: commitInfo,
        paths: appliedEdits.paths || [],
        appliedEdits,
        result: leadResultObj,
        noChanges,
        plan: planOutcome || undefined
    };
}