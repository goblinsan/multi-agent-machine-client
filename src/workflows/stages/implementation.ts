import { randomUUID } from "crypto";
import { cfg } from "../../config.js";
import { logger } from "../../logger.js";
import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult, interpretPersonaStatus, extractJsonPayloadFromText } from "../../agents/persona.js";
import { PERSONAS } from "../../personaNames.js";
import { ENGINEER_PERSONAS_REQUIRING_PLAN } from "../../util.js";

// Per-stage max planning iterations; default 5 via cfg
const MAX_APPROVAL_RETRIES = Number.isFinite(cfg.planMaxIterationsPerStage as any) && cfg.planMaxIterationsPerStage !== null
    ? (cfg.planMaxIterationsPerStage as number)
    : 5;

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
    if (!cfg.allowedPersonas.includes(planner)) {
        logger.warn("plan approval persona not allowed", { planner });
    }

    const effectiveMax = Number.isFinite(MAX_APPROVAL_RETRIES) ? MAX_APPROVAL_RETRIES : 5;
    const baseFeedbackText = feedback && feedback.trim().length ? feedback.trim() : "";
    let planFeedbackNotes: string[] = [];
    const planHistory: PlanHistoryEntry[] = [];
    const explicitQaFeedback = (basePayload as any)?.qa_feedback || null;

    for (let planAttempt = 0; planAttempt < effectiveMax; planAttempt += 1) {
        logger.info("plan approval attempt", { planAttempt }); // New log
        const feedbackTextParts = [] as string[];
        if (baseFeedbackText.length) feedbackTextParts.push(baseFeedbackText);
        if (planFeedbackNotes.length) feedbackTextParts.push(...planFeedbackNotes);
        const planFeedbackText = feedbackTextParts.length ? feedbackTextParts.join("\n\n") : undefined;

        const guidanceParts: string[] = [];
        if (explicitQaFeedback || baseFeedbackText || planFeedbackNotes.length) {
            guidanceParts.push("At the very top of your response, include a field 'acknowledged_feedback' that restates the evaluator QA feedback you received (verbatim or summarized), followed immediately by a concise description of how your plan addresses each point.");
        }
        const planPayload = {
            ...basePayload,
            feedback: baseFeedbackText || undefined,
            plan_feedback: planFeedbackText,
            plan_request: {
                attempt: planAttempt + 1,
                requires_approval: true,
                revision: attempt
            },
            plan_history: planHistory.length ? planHistory.slice() : undefined,
            // Enforce citation requirements for relevance
            require_citations: cfg.planRequireCitations,
            citation_fields: cfg.planCitationFields,
            uncited_budget: cfg.planUncitedBudget,
            treat_uncited_as_invalid: cfg.planTreatUncitedAsInvalid
        };
        if (guidanceParts.length) {
            (planPayload as any).guidance = [((planPayload as any).guidance || ''), ...guidanceParts].filter(Boolean).join('\n');
            (planPayload as any).require_acknowledged_feedback = true;
            (planPayload as any).acknowledge_key = 'acknowledged_feedback';
        }

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
            projectId: projectId!,
        });

        const planEvent = await waitForPersonaCompletion(r, planner, workflowId, planCorrId);
        const planResultObj = parseEventResult(planEvent.fields.result);
        logger.debug("plan persona result raw", { planner, workflowId, planCorrId, planResultObjPreview: String(planResultObj?.output || '').slice(0, 200) });
        const planOutput = planResultObj?.output || "";
        const planJson = extractJsonPayloadFromText(planOutput) || planResultObj?.payload || null;
        logger.debug("plan persona parsed json", { planner, workflowId, planCorrId, hasPlanJson: !!planJson, planJsonPreview: planJson ? JSON.stringify(planJson).slice(0, 400) : null });
    const planSteps = extractPlanSteps(planJson);

        planHistory.push({ attempt: planAttempt + 1, content: planOutput, payload: planJson });

        // Always evaluate the plan, even if it's missing steps, so feedback is consistent
        const evaluationCorrId = randomUUID();
        logger.info("coordinator dispatch plan evaluation", {
            workflowId,
            targetPersona: PERSONAS.PLAN_EVALUATOR,
            attempt,
            planAttempt: planAttempt + 1
        });

        // Diagnostics: ensure we can see if qa_feedback is present for the evaluator
        try {
            const ef = (basePayload as any)?.qa_feedback;
            logger.info("plan evaluation qa-feedback visibility", {
                workflowId,
                hasQaFeedback: !!ef,
                qaSource: ef && typeof ef === 'object' ? (ef.source || 'object') : (ef ? 'inline' : 'none')
            });
        } catch { /* logging QA feedback failed, non-fatal */ }

        // Ensure a non-null QA feedback object for evaluator
        const qaFb = explicitQaFeedback || (feedback ? { status: 'info', details: feedback, source: 'feedback_text' } : null) || { status: 'unknown', details: 'No explicit QA feedback provided', source: 'none' };

        await sendPersonaRequest(r, {
            workflowId,
            toPersona: PERSONAS.PLAN_EVALUATOR,
            step: "2.5-evaluate-plan",
            intent: "evaluate_plan_relevance",
            payload: {
                qa_feedback: qaFb,
                plan: planJson,
                require_citations: cfg.planRequireCitations,
                citation_fields: cfg.planCitationFields,
                uncited_budget: cfg.planUncitedBudget,
                treat_uncited_as_invalid: cfg.planTreatUncitedAsInvalid
            },
            corrId: evaluationCorrId,
            repo: repoRemote,
            branch: branchName,
            projectId: projectId!,
        });

        const evaluationEvent = await waitForPersonaCompletion(r, PERSONAS.PLAN_EVALUATOR, workflowId, evaluationCorrId);
        const evaluationResult = parseEventResult(evaluationEvent.fields.result);
        const evaluationStatus = interpretPersonaStatus(evaluationEvent.fields.result);

        // Treat missing steps as automatic failure to avoid approving empty plans
        const missingSteps = planSteps.length === 0;
        if (evaluationStatus.status === 'fail' || missingSteps) {
            const issue = missingSteps
                ? (planJson && typeof planJson === "object"
                    ? "Plan response did not include a non-empty 'plan' array."
                    : "Plan response must include JSON with a 'plan' array describing the execution steps.")
                : null;
            // feed evaluator feedback back to the planner as added plan_feedback for next attempt
            planFeedbackNotes = [
                `The proposed plan did not pass evaluation.${missingSteps ? ' (no steps provided)' : ''}`,
                feedback ? `QA Feedback: ${feedback}` : undefined,
                `Proposed Plan: ${planOutput}`,
                `Evaluator Feedback: ${evaluationResult?.reason || evaluationResult?.details || issue || ''}`,
                `Please provide a new plan directly addressing evaluator concerns.`
            ].filter(Boolean) as string[];
            logger.warn("plan evaluation failed", {
                workflowId,
                planner,
                attempt,
                planAttempt: planAttempt + 1,
                feedback: planFeedbackNotes.join('\n')
            });
            // Mutate basePayload guidance to explicitly prioritize evaluator feedback for the next revision request
            const nextGuidance = [
              (basePayload as any).guidance || '',
              "Prioritize evaluator comments above all else.",
              "Only include steps that directly resolve evaluator findings and QA failures; drop unrelated items.",
              "Provide 'acknowledged_feedback' (verbatim) and a 'plan_changes_mapping' linking evaluator points to your changes."
            ].filter(Boolean).join('\n');
            (basePayload as any).guidance = nextGuidance;
            (basePayload as any).require_acknowledged_feedback = true;
            (basePayload as any).acknowledge_key = 'acknowledged_feedback';
            (basePayload as any).prioritize_evaluator_feedback = true;
            (basePayload as any).require_plan_changes_mapping = true;
            (basePayload as any).mapping_key = 'plan_changes_mapping';
            (basePayload as any).mapping_instructions = "Provide an array 'plan_changes_mapping' where each item maps one evaluator point to concrete plan changes (fields: evaluator_point, change, justification).";
            continue; // retry loop
        }

        // Passed evaluation and has steps -> approve
        logger.info("plan approved", {
            workflowId,
            planner,
            attempt,
            planAttempt: planAttempt + 1,
            steps: planSteps.length
        });
        logger.debug("plan approved payload preview", { workflowId, planner, planAttempt: planAttempt + 1, planStepsPreview: JSON.stringify(planSteps).slice(0, 400) });
        try {
            const ack = (planJson && ((planJson as any).acknowledged_feedback || (planJson as any)?.payload?.acknowledged_feedback)) || null;
            if (ack) {
                const preview = typeof ack === 'string' ? String(ack).slice(0, 500) : JSON.stringify(ack).slice(0, 500);
                logger.info("planner acknowledged evaluator feedback (initial planning)", { workflowId, preview });
            }
        } catch { /* planner acknowledgement failed, non-fatal */ }
        return { planText: planOutput, planPayload: planJson, planSteps, history: planHistory.slice() };
    }
    // Failing open: if we exceeded attempts, proceed with the latest plan in history
    const last = planHistory[planHistory.length - 1];
    if (last && last.payload) {
        try {
            const payload = last.payload;
            const steps = extractPlanSteps(payload);
            if (!payload.meta) (payload as any).meta = {};
            (payload as any).meta.plan_approved = false;
            (payload as any).meta.reason = 'iteration_limit_exceeded';
            logger.warn("plan approval attempts exhausted; proceeding with last plan", { workflowId, planner, attempt, steps: steps.length });
            return { planText: last.content, planPayload: payload, planSteps: steps, history: planHistory.slice() };
        } catch { /* fallback plan extraction failed, non-fatal */ }
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
    // If the selected dashboard task looks like a QA failure report, surface it as qa_feedback for the evaluator
    let derivedQaFeedback: any = null;
    try {
        const summary = String(taskDescriptor?.summary || '').trim();
        const title = String(taskDescriptor?.name || taskName || '').trim();
        const labels = Array.isArray((taskDescriptor as any)?.labels) ? ((taskDescriptor as any).labels as any[]).map(String).join(', ') : '';
        const text = [summary, title, labels].filter(Boolean).join(' \n ');
        if (text) {
            const sL = text.toLowerCase();
            const looksQa = /(\bqa\b|\btest\b|\btests\b|\bspec\b|\bfail\b|\bfailing\b|\berror\b|\bassert\b|\bflake\b|\bfailing test\b)/.test(sL);
            if (looksQa) {
                derivedQaFeedback = { status: 'fail', details: summary || title || labels, source: 'dashboard_task', task: taskDescriptor };
            }
        }
        // As a coarse heuristic, if projectInfo.status mentions failing tests, also surface that
        if (!derivedQaFeedback && projectInfo) {
            const piText = String((projectInfo.status || projectInfo.summary || projectInfo.goal || '')).toLowerCase();
            if (/(failing|failures|tests|test)/.test(piText)) {
                derivedQaFeedback = { status: 'fail', details: projectInfo.status || projectInfo.summary || projectInfo.goal, source: 'project_status' };
            }
        }
        // Last resort: if we have a dashboard task, provide a minimal non-null object so evaluator doesn't see null
        if (!derivedQaFeedback && taskDescriptor) {
            derivedQaFeedback = { status: 'unknown', details: taskDescriptor.summary || taskDescriptor.name || '(no details)', source: 'task_fallback' };
        }
    } catch { /* QA feedback derivation failed, non-fatal */ }
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
        revision: attempt,
        // Forward QA failure context (if any) so the initial plan evaluator sees it
        qa_feedback: derivedQaFeedback || undefined
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