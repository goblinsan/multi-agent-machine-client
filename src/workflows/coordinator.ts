import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { fetchProjectStatus, fetchProjectStatusDetails } from "../dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, checkoutBranchFromBase, ensureBranchPublished, commitAndPushPaths, detectRemoteDefaultBranch } from "../gitUtils.js";
import { logger } from "../logger.js";
import { firstString, slugify } from "../util.js";
import { buildBranchName } from "../branchUtils.js";
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
  detectRemoteDefaultBranch,
    checkoutBranchFromBase,
    ensureBranchPublished,
    commitAndPushPaths,
    updateTaskStatus,
    applyEditOps,
    parseUnifiedDiffToEditSpec,
    handleFailureMiniCycle,
    runLeadCycle,
    // Governance hook (code-review/security). Default implementation dispatches
    // code-reviewer and security-review personas when allowed by config.
    governanceHook: async (r: any, ctx: any) => {
      try {
        const P = (ctx && ctx.persona) ? ctx.persona : persona;
        const toRun: Array<{ name: string; step: string }> = [];
        if (cfg.allowedPersonas.includes(PERSONAS.CODE_REVIEWER)) toRun.push({ name: PERSONAS.CODE_REVIEWER, step: "3.8-code-review" });
        if (cfg.allowedPersonas.includes(PERSONAS.SECURITY_REVIEW)) toRun.push({ name: PERSONAS.SECURITY_REVIEW, step: "3.9-security-review" });
        for (const p of toRun) {
          const corrId = randomUUID();
          await P.sendPersonaRequest(r, {
            workflowId: ctx.workflowId,
            toPersona: p.name,
            step: p.step,
            intent: p.name === PERSONAS.CODE_REVIEWER ? "code_review" : "security_review",
            payload: {
              repo: ctx.repo,
              branch: ctx.branch,
              project_id: ctx.projectId,
              milestone: ctx.milestone,
              task: ctx.task,
              qa_result: ctx.qa || undefined
            },
            corrId,
            repo: ctx.repo,
            branch: ctx.branch,
            projectId: ctx.projectId
          });
          const evt = await P.waitForPersonaCompletion(r, p.name, ctx.workflowId, corrId);
          const status = P.interpretPersonaStatus(evt.fields.result);
          const resObj = P.parseEventResult(evt.fields.result);
          logger.info("governance persona completed", { workflowId: ctx.workflowId, persona: p.name, status: status.status, eventId: evt.id });
          // For now, only log outcomes. If needed, map resObj.issues/details into follow-ups.
        }
      } catch (err) {
        logger.warn("governanceHook default failed", { error: String(err) });
      }
    },
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

type TddHints = {
  workflow_mode?: string | null;
  tdd_stage?: string | null;
  qa_expectations?: any;
};
function normalizeLabels(value: any): string[] {
  const out: string[] = [];
  const pushStr = (s: any) => { if (typeof s === 'string' && s.trim()) out.push(s.trim()); };
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const it of value) {
      if (typeof it === 'string') pushStr(it);
      else if (it && typeof it === 'object') pushStr((it as any).name || (it as any).label || (it as any).value || '');
    }
  } else if (typeof value === 'object') {
    for (const v of Object.values(value)) pushStr(v as any);
  } else {
    pushStr(value);
  }
  return out.map(s => s.toLowerCase());
}

function detectTddHints(msg: any, payload: any, project?: any, milestone?: any, task?: any): TddHints {
  // Highest priority: explicit fields in msg/payload
  let workflow_mode = firstString(msg?.workflow_mode, payload?.workflow_mode) || null;
  let tdd_stage = firstString(msg?.tdd_stage, payload?.tdd_stage) || null;
  // Alternate shapes like tdd: { stage }
  if (!tdd_stage) tdd_stage = firstString((payload?.tdd && payload?.tdd.stage), (msg?.tdd && msg?.tdd.stage)) || null;
  let qa_expectations = (msg && (msg.qa_expectations || msg.qa)) || (payload && (payload.qa_expectations || payload.qa)) || null;

  // Next: task/milestone/project-level fields
  const candidates = [task, milestone, project];
  for (const src of candidates) {
    if (!src || typeof src !== 'object') continue;
    workflow_mode = workflow_mode || firstString((src as any).workflow_mode, (src as any).mode, (src as any).workflow);
    tdd_stage = tdd_stage || firstString((src as any).tdd_stage, (src as any).stage);
    qa_expectations = qa_expectations || (src as any).qa_expectations || (src as any).qa || null;
    // Labels/tags heuristics
    const labels = normalizeLabels((src as any).labels || (src as any).tags || (src as any).label || (src as any).tag);
    if (labels.length) {
      if (!workflow_mode && labels.includes('tdd')) workflow_mode = 'tdd';
      // stage:* pattern
      const stageLbl = labels.find(l => l.startsWith('stage:'));
      if (!tdd_stage && stageLbl) tdd_stage = stageLbl.split(':')[1] || null;
      // qa expectations hints
      if (!qa_expectations) {
        const expectFail = labels.includes('qa:expect_failures') || labels.includes('qa:expected_failures');
        if (expectFail) qa_expectations = { expect_failures: true };
      }
    }
  }

  return { workflow_mode: workflow_mode || null, tdd_stage: tdd_stage || null, qa_expectations };
}

function pickRemoteFrom(obj: any): string | null {
  if (!obj) return null;
  const candidates = [
    obj.repo, obj.remote, obj.url,
    obj.repository, obj.repository_url, obj.repositoryUrl,
    obj.git_url, obj.gitUrl, obj.github_url, obj.githubUrl,
    (obj.repository && typeof obj.repository === 'object' ? (obj.repository.url || obj.repository.ssh_url || obj.repository.git_url) : null)
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length) return c.trim();
    if (Array.isArray(c) && c.length) {
      for (const it of c) {
        const v = pickRemoteFrom(it);
        if (v) return v;
      }
    }
  }
  // common array shapes: repositories, repos
  if (Array.isArray(obj.repositories)) {
    for (const it of obj.repositories) {
      const v = pickRemoteFrom(it);
      if (v) return v;
    }
  }
  if (Array.isArray(obj.repos)) {
    for (const it of obj.repos) {
      const v = pickRemoteFrom(it);
      if (v) return v;
    }
  }
  return null;
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
  // Global defaults (may be overridden per-task below)
  const tddDefaults = detectTddHints(msg, payload, projectInfo, details, null);
  const projectName: string = firstString(projectInfo?.name, payload?.project_name) || 'project';
  const projectSlug: string = slugify(firstString(projectInfo?.slug, payload?.project_slug, projectName) || projectName || 'project');

  // Always resolve repository from dashboard (or payload override) before any git operation
  const repoRemoteCandidate = firstString(
    pickRemoteFrom(details),
    pickRemoteFrom(projectInfo),
    pickRemoteFrom(payload)
  ) || '';
  if (!repoRemoteCandidate) {
    throw new Error(`No repository remote available for project ${projectId}. Set the project's repository URL in the dashboard.`);
  }
  let repoResolution = await H.resolveRepoFromPayload({ ...payload, repo: repoRemoteCandidate, project_name: projectName, project_slug: projectSlug });
  let repoRoot = repoResolution.repoRoot;
  let repoMeta = await H.getRepoMetadata(repoRoot);
  // Prefer the remote's default branch rather than the local current branch (which could be a feature branch)
  let detectedDefault = await H.detectRemoteDefaultBranch(repoRoot).catch(() => null);
  let baseBranch = repoResolution.branch || detectedDefault || cfg.git.defaultBranch || 'main';
  logger.info("coordinator repo-resolve checkpoint", {
    workflowId,
    repoRoot,
    source: (repoResolution as any)?.source || 'unknown',
    hasGit: !!(repoMeta.currentBranch || repoMeta.remoteSlug),
    remoteCandidate: true
  });

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
      external_id: firstString((selectedTask as any)?.external_id, (selectedTask as any)?.externalId) || null,
      name: taskName,
      slug: taskSlug,
      status: selectedTask?.status ?? null,
      normalized_status: normalizeTaskStatus(selectedTask?.status),
      branch: firstString(selectedTask?.branch, selectedTask?.branch_name, selectedTask?.branchName) || null,
      summary: firstString(selectedTask?.summary, selectedTask?.description) || null
    } : null;

  const branchName = buildBranchName(selectedMilestone, selectedTask, projectSlug, milestoneSlug, taskSlug);

    logger.info("coordinator branch selection", {
      workflowId,
      repoRoot,
      baseBranch,
      branchName,
      milestone: selectedMilestone ? { id: selectedMilestone.id ?? milestoneSlug, slug: milestoneSlug } : null,
      task: taskDescriptor ? { id: taskDescriptor.id, slug: taskDescriptor.slug } : null
    });

    // Attempt checkout, with a single fallback re-resolve if checkout fails due to missing base branch
    try {
      await H.checkoutBranchFromBase(repoRoot, baseBranch, branchName);
    } catch (err: any) {
      const msg = String(err?.message || err);
      throw new Error(`checkout failed: ${msg}`);
    }

    // Ensure the branch exists on the remote as well (new milestones may not have a branch yet)
    try {
      await H.ensureBranchPublished(repoRoot, branchName);
    } catch {}

    let repoSlug = repoMeta.remoteSlug;
    let repoRemote = repoSlug ? `https://${repoSlug}.git` : (firstString(pickRemoteFrom(payload), pickRemoteFrom(projectInfo), pickRemoteFrom(details), repoMeta.remoteUrl, repoResolution.remote) || "");
    if (!repoRemote) throw new Error("Coordinator could not determine repo remote");

    // Context step
    const contextCorrId = randomUUID();
    // Compute TDD hints for this item (task/milestone) using dashboard metadata
    const tddHints = detectTddHints(msg, payload, projectInfo, selectedMilestone, selectedTask);
    const effectiveTdd = {
      workflow_mode: tddHints.workflow_mode || tddDefaults.workflow_mode || undefined,
      tdd_stage: tddHints.tdd_stage || tddDefaults.tdd_stage || undefined,
      qa_expectations: tddHints.qa_expectations || tddDefaults.qa_expectations || undefined
    };

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
        upload_dashboard: true,
        // propagate TDD hints for downstream personas that might care
        workflow_mode: effectiveTdd.workflow_mode,
        tdd_stage: effectiveTdd.tdd_stage,
        qa_expectations: effectiveTdd.qa_expectations
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

    if (taskDescriptor && (taskDescriptor.id || taskDescriptor.external_id) && (appliedSomething || (leadOutcome && leadOutcome.success))) {
      try {
        const key = String(taskDescriptor.external_id || taskDescriptor.id);
        const updateRes = await H.updateTaskStatus(key, 'done');
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
      payload: {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        milestone: milestoneDescriptor,
        task: taskDescriptor,
        commands: qaCommands,
        // TDD hints allow QA to treat expected failing tests as pass
        workflow_mode: effectiveTdd.workflow_mode,
        tdd_stage: effectiveTdd.tdd_stage,
        qa_expectations: effectiveTdd.qa_expectations
      },
      corrId: qaCorr,
      repo: repoRemote,
      branch: branchName,
      projectId
    });
    const qaEvent = await H.persona.waitForPersonaCompletion(r, PERSONAS.TESTER_QA, workflowId, qaCorr);
    const qaResult = H.persona.parseEventResult(qaEvent.fields.result);
    const qaStatus = H.persona.interpretPersonaStatus(qaEvent.fields.result);
    logger.info("coordinator received QA completion", { workflowId, qaStatus: qaStatus.status, corrId: qaCorr, eventId: qaEvent.id });

    // Optional governance: code-review/security. Gate during TDD write_failing_test stage.
  const isFailingTestStage = String((effectiveTdd.tdd_stage || '')).toLowerCase() === 'write_failing_test';
    if (!isFailingTestStage && qaStatus.status === 'pass') {
      try {
        await H.governanceHook(r, {
          workflowId,
          repo: repoRemote,
          branch: branchName,
          projectId,
          milestone: milestoneDescriptor,
          task: taskDescriptor,
          qa: qaResult,
          persona: H.persona
        });
      } catch (gerr) {
        logger.warn('coordinator: governanceHook failed', { workflowId, error: String(gerr) });
      }
    } else if (isFailingTestStage) {
      logger.info('coordinator: skipping code-review/security due to TDD failing test stage', { workflowId, tdd_stage: tddHints.tdd_stage });
    }

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
        if (evaluationStatus.status !== 'pass') {
          const evalObj = persona.parseEventResult(evaluationEvent.fields.result);
          logger.warn("qa follow-up plan rejected; requesting planner revision", { workflowId, evaluator: PERSONAS.PLAN_EVALUATOR, reason: (evalObj && (evalObj.reason || evalObj.details)) || 'unspecified' });
          try {
            const revCorr = randomUUID();
            await persona.sendPersonaRequest(r, {
              workflowId,
              toPersona: PERSONAS.IMPLEMENTATION_PLANNER,
              step: "3.6-plan-revision",
              intent: "revise_plan",
              payload: {
                qa_feedback: qaResult?.payload ?? qaResult,
                evaluator_feedback: evalObj,
                previous_plan: mini.plannerResult,
                guidance: "Revise the plan to directly address the QA feedback; ensure each step maps to a failing test or acceptance criterion and is small and verifiable."
              },
              corrId: revCorr,
              repo: repoRemote,
              branch: branchName,
              projectId
            });
            const revEvent = await persona.waitForPersonaCompletion(r, PERSONAS.IMPLEMENTATION_PLANNER, workflowId, revCorr);
            const revised = persona.parseEventResult(revEvent.fields.result);
            // Re-evaluate revised plan
            const reevaluateCorr = randomUUID();
            await persona.sendPersonaRequest(r, {
              workflowId,
              toPersona: PERSONAS.PLAN_EVALUATOR,
              step: "3.7-evaluate-qa-plan-revised",
              intent: "evaluate_plan_relevance",
              payload: { qa_feedback: qaResult, plan: revised },
              corrId: reevaluateCorr,
              repo: repoRemote,
              branch: branchName,
              projectId
            });
            const reevaluateEvent = await persona.waitForPersonaCompletion(r, PERSONAS.PLAN_EVALUATOR, workflowId, reevaluateCorr);
            const reevaluateStatus = persona.interpretPersonaStatus(reevaluateEvent.fields.result);
            if (reevaluateStatus.status !== 'pass') {
              logger.warn("qa follow-up revised plan still rejected; skipping forward to implementation", { workflowId });
              // Do not throw; skip forwarding step
              // Clear plannerResult to prevent forwarding below
              (mini as any).plannerResult = null;
            } else {
              (mini as any).plannerResult = revised;
            }
          } catch (revErr) {
            logger.warn("qa follow-up: failed to obtain or re-evaluate revised plan", { workflowId, error: String(revErr) });
            // Skip forwarding step by clearing plannerResult
            (mini as any).plannerResult = null;
          }
        }

        // forward to implementation planning if evaluator passes
        try {
          const implCorr = randomUUID();
          const implPersona = cfg.allowedPersonas.includes(PERSONAS.IMPLEMENTATION_PLANNER) ? PERSONAS.IMPLEMENTATION_PLANNER : PERSONAS.LEAD_ENGINEER;
          if (mini.plannerResult) await H.persona.sendPersonaRequest(r, {
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
