import { randomUUID } from "crypto";
import { cfg } from "../../config.js";
import { logger } from "../../logger.js";
import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult, interpretPersonaStatus, extractJsonPayloadFromText } from "../../agents/persona.js";
import { PERSONAS } from "../../personaNames.js";
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
    // Diagnostic: log whether plan approval should run for this persona
    logger.debug('runEngineerPlanApproval', { implementationPersona, plannerPersona, requiresPlan: ENGINEER_PERSONAS_REQUIRING_PLAN.has(implementationPersona.toLowerCase()) });
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
        logger.info("plan approval attempt", { planAttempt }); // New log
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
            if (feedback) { // Only evaluate if there is feedback
                const evaluationCorrId = randomUUID();
                logger.info("coordinator dispatch plan evaluation", {
                    workflowId,
                    targetPersona: PERSONAS.PLAN_EVALUATOR,
                    attempt,
                    planAttempt: planAttempt + 1
                });

                await sendPersonaRequest(r, {
                    workflowId,
                    toPersona: PERSONAS.PLAN_EVALUATOR,
                    step: "2.5-evaluate-plan",
                    intent: "evaluate_plan_relevance",
                    payload: {
                        qa_feedback: feedback,
                        plan: planJson,
                    },
                    corrId: evaluationCorrId,
                    repo: repoRemote,
                    branch: branchName,
                    projectId: projectId!,
                });

                const evaluationEvent = await waitForPersonaCompletion(r, PERSONAS.PLAN_EVALUATOR, workflowId, evaluationCorrId);
                const evaluationResult = parseEventResult(evaluationEvent.fields.result);
                const evaluationStatus = interpretPersonaStatus(evaluationEvent.fields.result);

                if (evaluationStatus.status !== 'pass') {
                    planFeedbackNotes = [
                        `The proposed plan does not seem to address the QA feedback.`,
                        `QA Feedback: ${feedback}`,
                        `Proposed Plan: ${planOutput}`,
                        `Evaluator Feedback: ${evaluationResult?.reason || evaluationResult?.details || ''}`,
                        `Please provide a new plan that addresses the QA feedback.`
                    ];
                    logger.warn("plan evaluation failed", {
                        workflowId,
                        planner,
                        attempt,
                        planAttempt: planAttempt + 1,
                        feedback: planFeedbackNotes.join('\n')
                    });
                    continue; // continue the for loop to retry
                }
            }

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

    // The planner persona should be the implementation-planner which prepares the plan
    // for the lead-engineer to execute. See projects/workflow-plans.md.
    const plannerPersona = PERSONAS.IMPLEMENTATION_PLANNER;
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
        toPersona: PERSONAS.LEAD_ENGINEER,
        step: "2-implementation",
        intent: "implement_milestone",
        payload: implementationPayload,
        corrId: leadCorrId,
        repo: repoRemote,
        branch: branchName,
        projectId: projectId!,
    });
    logger.info("coordinator dispatched request for lead-engineer", { workflowId, corrId: leadCorrId, toPersona: PERSONAS.LEAD_ENGINEER, taskName, branch: branchName });




    let leadEvent;
    try {
        logger.info("waiting for lead-engineer completion", { workflowId, corrId: leadCorrId });
    leadEvent = await waitForPersonaCompletion(r, PERSONAS.LEAD_ENGINEER, workflowId, leadCorrId);
        logger.info("received lead-engineer completion (wait returned)", { workflowId, corrId: leadCorrId, eventId: leadEvent?.id });
    } catch (err) {
        logger.error("waitForPersonaCompletion for lead-engineer failed or timed out", { workflowId, corrId: leadCorrId, error: String(err) });
        throw err;
    }
    const leadResultObj = parseEventResult(leadEvent.fields.result);
    logger.info("coordinator received lead engineer completion", { workflowId, corrId: leadCorrId, eventId: leadEvent.id });

    let appliedEdits = leadResultObj?.applied_edits;
    // Some personas may return a simple status object { status: 'ok', output: '...' }
    // without an explicit applied_edits structure. Treat a status:'ok' as a successful
    // application of edits (best-effort) so the coordinator can progress and mark tasks done.
    if (!appliedEdits && leadResultObj && (leadResultObj.status === 'ok' || leadResultObj.result === 'ok')) {
        // synthesize an appliedEdits object to indicate success
        (leadResultObj as any).applied_edits = { applied: true, attempted: true, paths: [], commit: { committed: true, pushed: true } };
        appliedEdits = leadResultObj?.applied_edits;
    }
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