import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { fetchProjectStatus, fetchProjectStatusDetails } from "../dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, checkoutBranchFromBase, ensureBranchPublished, commitAndPushPaths } from "../gitUtils.js";
import { logger } from "../logger.js";
import { firstString, slugify } from "../util.js";
import * as persona from "../agents/persona.js";
import { PERSONAS } from "../personaNames.js";
import { applyEditOps, parseUnifiedDiffToEditSpec, writeDiagnostic } from "../fileops.js";
import { updateTaskStatus } from "../dashboard.js";
import { handleFailureMiniCycle } from "./helpers/stageHelpers.js";
import { runLeadCycle } from "./stages/implementation.js";

type Overrides = Partial<ReturnType<typeof buildHelpers>>;

function buildHelpers() {
  return {
    fetchProjectStatus,
    fetchProjectStatusDetails,
    resolveRepoFromPayload,
    getRepoMetadata,
    checkoutBranchFromBase,
    ensureBranchPublished,
    commitAndPushPaths,
    updateTaskStatus,
    applyEditOps,
    parseUnifiedDiffToEditSpec,
    handleFailureMiniCycle,
    runLeadCycle,
    persona: {
      sendPersonaRequest: persona.sendPersonaRequest,
      waitForPersonaCompletion: persona.waitForPersonaCompletion,
      parseEventResult: persona.parseEventResult,
      interpretPersonaStatus: persona.interpretPersonaStatus,
    },
  };
}

function normalizeTaskStatus(status: string | undefined | null) {
  if (!status) return "open";
  const s = String(status).toLowerCase();
  if (["done","completed","closed"].includes(s)) return "done";
  if (["in_progress","in-progress","progress","active"].includes(s)) return "in_progress";
  return "open";
}

function toSlug(s: string | null | undefined, fallback: string) {
  const v = firstString(s, fallback) || fallback;
  return slugify(v);
}

async function detectTestCommands(repoRoot: string) {
  const cmds: string[] = [];
  try {
    const path = (await import("path")).default;
    const fs = await import("fs/promises");
    const pjPath = path.join(repoRoot, 'package.json');
    const pj = JSON.parse(await fs.readFile(pjPath, 'utf8'));
    const scripts = pj && pj.scripts ? pj.scripts : {};
    if (scripts.test) cmds.push('npm test');
    if (scripts.lint) cmds.push('npm run lint');
  } catch {}
  return cmds;
}

function extractDiffCandidates(leadOutcome: any): string[] {
  const rawCandidates: Array<string | null> = [];
  try {
    const r = (leadOutcome as any)?.result;
    if (typeof r === 'string') rawCandidates.push(r);
    if (r && typeof r === 'object') {
      rawCandidates.push(r.preview ?? null);
      rawCandidates.push(r.output ?? null);
      rawCandidates.push(r.raw && typeof r.raw === 'string' ? r.raw : null);
      rawCandidates.push(r.message ?? null);
      rawCandidates.push(r.text ?? null);
      rawCandidates.push(r.body ?? null);
    }
    rawCandidates.push((leadOutcome as any).preview && typeof (leadOutcome as any).preview === 'string' ? (leadOutcome as any).preview : null);
    rawCandidates.push((leadOutcome as any).output && typeof (leadOutcome as any).output === 'string' ? (leadOutcome as any).output : null);
  } catch {}

  const normalized: string[] = [];
  for (const c of rawCandidates) {
    if (!c || typeof c !== 'string') continue;
    let txt = c;
    const fenceRe = /```(?:diff)?\n([\s\S]*?)```/g;
    const matches = Array.from(txt.matchAll(fenceRe));
    if (matches && matches.length) {
      let chosen: string | null = null;
      for (const m of matches) {
        const inner = m[1] || '';
        if (inner.includes('diff --git') || inner.includes('@@') || inner.includes('+++ b/')) { chosen = inner; break; }
      }
      if (!chosen) chosen = matches[0][1] || null;
      if (chosen) txt = chosen;
    }
  const idx = txt.search(/(^|\n)(diff --git |@@ |\+\+\+ b\/)/);
    if (idx >= 0) txt = txt.slice(idx);
    if (txt.includes('diff --git') || txt.includes('@@') || txt.includes('+++ b/')) normalized.push(txt);
  }
  return normalized;
}

export async function handleCoordinator(r: any, msg: any, payload: any, overrides?: Overrides) {
  const H = Object.assign(buildHelpers(), overrides || {});
  const workflowId: string = firstString(msg?.workflow_id) || randomUUID();
  const projectId: string = firstString(msg?.project_id, payload?.project_id, payload?.projectId) || '';
  if (!projectId) throw new Error("Coordinator requires project_id");

  const projectInfo: any = await H.fetchProjectStatus(projectId);
  const details: any = await H.fetchProjectStatusDetails(projectId).catch(() => null);

  let repoResolution = await H.resolveRepoFromPayload(payload || {});
  let repoRoot = repoResolution.repoRoot;
  let repoMeta = await H.getRepoMetadata(repoRoot);
  let baseBranch = repoResolution.branch || repoMeta.currentBranch || cfg.git.defaultBranch || 'main';
  const projectName: string = firstString(projectInfo?.name, payload?.project_name) || 'project';
  const projectSlug: string = slugify(firstString(projectInfo?.slug, payload?.project_slug, projectName) || projectName || 'project');

  // If the initially resolved repoRoot isn't a git repo, attempt a re-resolve using any available remote BEFORE checkout
  let repoRemoteCandidate = firstString(payload?.repo, (projectInfo as any)?.repository?.url, repoMeta.remoteUrl, repoResolution.remote) || '';
  if ((!repoMeta.currentBranch && !repoMeta.remoteSlug) && repoRemoteCandidate) {
    const re = await H.resolveRepoFromPayload({ ...payload, repo: repoRemoteCandidate, project_name: projectName, project_slug: projectSlug });
    repoResolution = re;
    repoRoot = re.repoRoot;
    repoMeta = await H.getRepoMetadata(repoRoot);
    baseBranch = re.branch || repoMeta.currentBranch || cfg.git.defaultBranch || baseBranch;
  }

  // Build a flat list of tasks with milestone context if available
  type Item = { milestone: any | null; task: any };
  const items: Item[] = [];
  if (details && Array.isArray((details as any).milestones) && (details as any).milestones.length) {
    for (const m of (details as any).milestones) {
      const arr = Array.isArray(m?.tasks) ? m.tasks : [];
      for (const t of arr) items.push({ milestone: m, task: t });
    }
  } else {
    const arr = Array.isArray((projectInfo as any)?.tasks) ? (projectInfo as any).tasks : [];
    for (const t of arr) items.push({ milestone: null, task: t });
  }

  const pending = items.filter(it => normalizeTaskStatus(it.task?.status) !== 'done');
  const toProcess: Item[] = pending.length ? pending : [{ milestone: null, task: { id: firstString(payload?.task_id, payload?.taskId, 't-synth') || 't-synth', name: firstString(payload?.task_name, 'task') || 'task', status: 'open' } }];

  for (const it of toProcess) {
    const selectedMilestone = it.milestone;
    const selectedTask = it.task;

  const milestoneName = firstString(selectedMilestone?.name, selectedMilestone?.title, 'Milestone');
  const milestoneNameText: string = milestoneName || 'Milestone';
  const milestoneSlug = toSlug(selectedMilestone?.slug, milestoneNameText || 'milestone');
    const taskName = firstString(selectedTask?.name, selectedTask?.title, selectedTask?.summary, selectedTask?.label, selectedTask?.key, selectedTask?.id) || null;
    const taskSlug = taskName ? slugify(taskName) : null;
    const taskDescriptor = selectedTask ? {
      id: firstString(selectedTask.id, selectedTask.key, taskSlug, taskName) || null,
      name: taskName,
      slug: taskSlug,
      status: selectedTask?.status ?? null,
      normalized_status: normalizeTaskStatus(selectedTask?.status),
      branch: firstString(selectedTask?.branch, selectedTask?.branch_name, selectedTask?.branchName) || null,
      summary: firstString(selectedTask?.summary, selectedTask?.description) || null
    } : null;

    let branchName = firstString(selectedMilestone?.branch, selectedMilestone?.branch_name, selectedMilestone?.branchName) || `milestone/${milestoneSlug}`;

    // Attempt checkout, with a single fallback re-resolve if checkout fails due to missing base branch
    try {
      await H.checkoutBranchFromBase(repoRoot, baseBranch, branchName);
    } catch (err: any) {
      const msg = String(err?.message || err);
      // Fallback: if checkout failed and we have a remote candidate, re-resolve and retry once
      if (repoRemoteCandidate) {
        const re = await H.resolveRepoFromPayload({ ...payload, repo: repoRemoteCandidate, project_name: projectName, project_slug: projectSlug });
        repoResolution = re;
        repoRoot = re.repoRoot;
        repoMeta = await H.getRepoMetadata(repoRoot);
        baseBranch = re.branch || repoMeta.currentBranch || cfg.git.defaultBranch || baseBranch;
        await H.checkoutBranchFromBase(repoRoot, baseBranch, branchName);
      } else {
        throw err;
      }
    }
    logger.info("coordinator prepared branch", { workflowId, repoRoot, baseBranch, branchName });

    let repoSlug = repoMeta.remoteSlug;
    let repoRemote = repoSlug ? `https://${repoSlug}.git` : (payload.repo || (projectInfo as any)?.repository?.url || repoMeta.remoteUrl || repoResolution.remote || "");
    if (!repoRemote) throw new Error("Coordinator could not determine repo remote");

    // Context step
    const contextCorrId = randomUUID();
    await H.persona.sendPersonaRequest(r, {
      workflowId,
      toPersona: PERSONAS.CONTEXT,
      step: "1-context",
      intent: "hydrate_project_context",
      payload: {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        project_slug: projectSlug,
        project_name: projectName,
        milestone: selectedMilestone ? { id: selectedMilestone.id ?? milestoneSlug, name: milestoneName, slug: milestoneSlug } : null,
  milestone_name: milestoneNameText,
        task: taskDescriptor,
        task_name: taskName || (taskDescriptor?.name ?? ""),
        upload_dashboard: true
      },
      corrId: contextCorrId,
      repo: repoRemote,
      branch: branchName,
      projectId
    });
    await H.persona.waitForPersonaCompletion(r, PERSONAS.CONTEXT, workflowId, contextCorrId);

    // Lead cycle (planner + lead)
    let feedbackNotes: string[] = [];
    let attempt = 0;
  const milestoneDescriptor = selectedMilestone ? { id: selectedMilestone.id ?? milestoneSlug, name: milestoneNameText, slug: milestoneSlug, task: taskDescriptor } : (taskDescriptor ? { task: taskDescriptor } : null);
  const leadOutcome = await H.runLeadCycle(r, workflowId, projectId, projectInfo, projectSlug, repoRemote, branchName, baseBranch, milestoneDescriptor, milestoneNameText, milestoneSlug, taskDescriptor, taskName, feedbackNotes, attempt);

    // Try to apply edits whenever the lead outcome contains a diff or structured ops
    // even if the lead did not apply the edits itself.
    let appliedSomething = false;
    try {
      if (logger.debug) logger.debug('leadOutcome', { taskId: taskDescriptor?.id, leadOutcome: (leadOutcome && typeof leadOutcome === 'object') ? { success: !!leadOutcome.success, noChanges: !!leadOutcome.noChanges } : leadOutcome });
      if (taskDescriptor && taskDescriptor.id && leadOutcome) {
        let editSpecObj: any = null;
        if (leadOutcome.result && typeof leadOutcome.result === 'object' && Array.isArray(leadOutcome.result.ops)) {
          editSpecObj = leadOutcome.result;
        } else {
          const candidates = extractDiffCandidates(leadOutcome);
          if (logger.debug) logger.debug('coordinator: normalizedCandidates', { workflowId, taskId: taskDescriptor?.id, count: candidates.length });
          for (const c of candidates) {
            try {
              const parsed = await H.parseUnifiedDiffToEditSpec(c);
              if (parsed && Array.isArray(parsed.ops) && parsed.ops.length) { editSpecObj = parsed; break; }
              else logger.debug('coordinator: diff candidate produced no ops', { workflowId, taskId: taskDescriptor?.id, candidatePreview: c.slice(0, 200) });
            } catch (err) {
              logger.debug('coordinator: parseUnifiedDiffToEditSpec threw', { workflowId, taskId: taskDescriptor?.id, error: String(err).slice(0,200) });
            }
          }
        }
        if (editSpecObj && Array.isArray(editSpecObj.ops) && editSpecObj.ops.length) {
          const editResult = await H.applyEditOps(JSON.stringify(editSpecObj), { repoRoot, branchName });
          if (editResult.changed.length > 0) {
            appliedSomething = true;
            try { await H.ensureBranchPublished(repoRoot, branchName); } catch {}
            await H.commitAndPushPaths({ repoRoot, branch: branchName, message: `feat: ${taskName}`, paths: editResult.changed });
          }
        } else {
          logger.info('coordinator: no edit operations detected in lead outcome', { workflowId, taskId: taskDescriptor?.id, leadOutcomeType: typeof (leadOutcome as any)?.result });
          try {
            const preview = (leadOutcome && typeof (leadOutcome as any).result === 'string') ? String((leadOutcome as any).result).slice(0, 4000) : '';
            await writeDiagnostic(repoRoot, 'coordinator-no-ops.json', { workflowId, taskId: taskDescriptor?.id || null, leadOutcomeType: typeof (leadOutcome as any)?.result, leadPreview: preview });
          } catch {}
        }
      }
    } catch (err) {
      logger.warn('coordinator: failed to apply lead-engineer diff/edit spec', { workflowId, error: err });
    }

    if (taskDescriptor && taskDescriptor.id && (appliedSomething || (leadOutcome && leadOutcome.success))) {
      try {
        const updateRes = await H.updateTaskStatus(String(taskDescriptor.id), 'done');
        if (!(updateRes && updateRes.ok)) logger.warn('coordinator: updateTaskStatus returned not-ok', { workflowId, taskId: String(taskDescriptor.id) });
      } catch (err) {
        logger.warn('coordinator: failed to mark task done after lead/apply', { workflowId, taskId: taskDescriptor.id, error: err });
      }
    }

    // QA step
    const qaCommands = await detectTestCommands(repoRoot);
    const qaCorr = randomUUID();
    await H.persona.sendPersonaRequest(r, {
      workflowId,
      toPersona: PERSONAS.TESTER_QA,
      step: "3-qa",
      intent: "run_qa",
      payload: { repo: repoRemote, branch: branchName, project_id: projectId, milestone: milestoneDescriptor, task: taskDescriptor, commands: qaCommands },
      corrId: qaCorr,
      repo: repoRemote,
      branch: branchName,
      projectId
    });
    const qaEvent = await H.persona.waitForPersonaCompletion(r, PERSONAS.TESTER_QA, workflowId, qaCorr);
    const qaResult = H.persona.parseEventResult(qaEvent.fields.result);
    const qaStatus = H.persona.interpretPersonaStatus(qaEvent.fields.result);
    logger.info("coordinator received QA completion", { workflowId, qaStatus: qaStatus.status, corrId: qaCorr, eventId: qaEvent.id });

    if (qaStatus.status === 'fail') {
      const qaPayloadObj = (qaResult && typeof qaResult === 'object') ? qaResult.payload ?? qaResult : null;
      let suggestedFromQa: any[] = [];
      if (qaPayloadObj) {
        const candidates = (qaPayloadObj as any).tasks || (qaPayloadObj as any).follow_ups || (qaPayloadObj as any).suggestions || (qaPayloadObj as any).backlog || null;
        if (Array.isArray(candidates) && candidates.length) suggestedFromQa = candidates.map((t: any) => (typeof t === 'object' ? t : { title: String(t) }));
      }
      if (!suggestedFromQa.length) {
        const detailsText = (qaPayloadObj && ((qaPayloadObj as any).details || (qaPayloadObj as any).message)) || (typeof qaResult === 'string' ? qaResult : (qaResult as any)?.details) || qaEvent.fields.result || 'QA reported failures';
        const title = `QA failure: ${String(((detailsText || '') as string).split('\n')[0]).slice(0, 120)}`;
        suggestedFromQa = [{ title, description: String(detailsText).slice(0, 5000), schedule: 'urgent', assigneePersona: 'implementation-planner' }];
      }
      const mini = await H.handleFailureMiniCycle(r, workflowId, 'qa', suggestedFromQa, {
        repo: repoRemote,
        branch: branchName,
        projectId,
        milestoneDescriptor,
        parentTaskDescriptor: taskDescriptor,
        projectName: projectInfo?.name || null,
        scheduleHint: payload?.scheduleHint,
        qaResult: qaResult
      });

      if (mini && mini.plannerResult) {
        const evaluationCorrId = randomUUID();
        await persona.sendPersonaRequest(r, {
          workflowId,
          toPersona: PERSONAS.PLAN_EVALUATOR,
          step: "3.5-evaluate-qa-plan",
          intent: "evaluate_plan_relevance",
          payload: { qa_feedback: qaResult, plan: mini.plannerResult },
          corrId: evaluationCorrId,
          repo: repoRemote,
          branch: branchName,
          projectId
        });
        const evaluationEvent = await persona.waitForPersonaCompletion(r, PERSONAS.PLAN_EVALUATOR, workflowId, evaluationCorrId);
        const evaluationStatus = persona.interpretPersonaStatus(evaluationEvent.fields.result);
        if (evaluationStatus.status !== 'pass') throw new Error(`Plan was rejected by ${PERSONAS.PLAN_EVALUATOR}`);

        // forward to implementation planning if evaluator passes
        try {
          const implCorr = randomUUID();
          const implPersona = cfg.allowedPersonas.includes(PERSONAS.IMPLEMENTATION_PLANNER) ? PERSONAS.IMPLEMENTATION_PLANNER : PERSONAS.LEAD_ENGINEER;
          await H.persona.sendPersonaRequest(r, {
            workflowId,
            toPersona: implPersona,
            step: "4-implementation-plan",
            intent: "handle_qa_followups",
            payload: { qa_result: qaResult?.payload ?? qaResult, planner_result: mini.plannerResult, created_tasks: mini.created, milestone: milestoneDescriptor, task: taskDescriptor, project_id: projectId },
            corrId: implCorr,
            repo: repoRemote,
            branch: branchName,
            projectId
          });
        } catch (err) {
          logger.warn("failed to forward mini planner result to implementation persona", { workflowId, error: err });
        }
      }

      // Also route via project-manager for additional follow-ups
      const pmCorr = randomUUID();
      await persona.sendPersonaRequest(r, {
        workflowId,
        toPersona: PERSONAS.PROJECT_MANAGER,
        step: "3-route",
        intent: "route_qa_followups",
        payload: { qa_result: qaResult?.payload ?? qaResult ?? qaEvent.fields.result, project_id: projectId, milestone: milestoneDescriptor, task: taskDescriptor },
        corrId: pmCorr,
        repo: repoRemote,
        branch: branchName,
        projectId
      });
      const pmEvent = await H.persona.waitForPersonaCompletion(r, PERSONAS.PROJECT_MANAGER, workflowId, pmCorr);
      const pmResult = H.persona.parseEventResult(pmEvent.fields.result) || {};
      let suggestedTasks = pmResult.payload?.tasks || pmResult.payload?.follow_ups || pmResult.payload?.backlog || pmResult.payload?.suggestions || pmResult.payload || null;
      if (!suggestedTasks) suggestedTasks = qaResult?.payload?.follow_ups || qaResult?.payload?.tasks || qaResult?.payload || [];
      if (!Array.isArray(suggestedTasks)) suggestedTasks = suggestedTasks && typeof suggestedTasks === 'object' ? [suggestedTasks] : [];
      if (suggestedTasks.length) {
        try {
          await H.handleFailureMiniCycle(r, workflowId, 'qa', suggestedTasks, {
            repo: repoRemote,
            branch: branchName,
            projectId,
            milestoneDescriptor,
            parentTaskDescriptor: taskDescriptor,
            projectName: projectInfo?.name || null,
            scheduleHint: payload?.scheduleHint,
            qaResult: qaResult
          });
        } catch (err) {
          logger.warn("coordinator: failed to process PM-suggested QA follow-ups", { workflowId, error: err });
        }
      }
    }
  }
}

export default { handleCoordinator };
