import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { fetchProjectStatus, fetchProjectStatusDetails } from "../dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, checkoutBranchFromBase, ensureBranchPublished, commitAndPushPaths, detectRemoteDefaultBranch, verifyRemoteBranchHasDiff, getBranchHeadSha } from "../gitUtils.js";
import { logger } from "../logger.js";
import { firstString, slugify } from "../util.js";
import { buildBranchName } from "../branchUtils.js";
import * as persona from "../agents/persona.js";
import { PERSONAS } from "../personaNames.js";
import { applyEditOps, parseUnifiedDiffToEditSpec, writeDiagnostic } from "../fileops.js";
import { updateTaskStatus } from "../dashboard.js";
import { handleFailureMiniCycle } from "./helpers/stageHelpers.js";
import { parseAgentEditsFromResponse } from "./helpers/agentResponseParser.js";
import { applyAgentCodeChanges } from "./helpers/codeApplication.js";
import { computeQaFollowupExternalId, findTaskIdByExternalId } from "../tasks/taskManager.js";
import { runLeadCycle } from "./stages/implementation.js";
import { sendPersonaRequest, waitForPersonaCompletion, parseEventResult, interpretPersonaStatus } from "../agents/persona.js";

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
    verifyRemoteBranchHasDiff,
    getBranchHeadSha,
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
  const recordDiagnostic = async (file: string, payload: any) => {
    try {
      await writeDiagnostic(repoRoot, file, payload);
    } catch {}
  };
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
  let toProcess: Item[];
  if (pending.length) {
    toProcess = pending;
  } else {
    // Fallback: prefer a milestone-based branch name using next_milestone when no open tasks
    const nextMs = (details && (details as any).next_milestone) || (projectInfo && (projectInfo as any).next_milestone) || null;
    const firstMs = (!nextMs && details && Array.isArray((details as any).milestones) && (details as any).milestones.length) ? (details as any).milestones[0] : null;
    const chosenMs = nextMs || firstMs || null;
    toProcess = [{ milestone: chosenMs, task: null as any }];
    // If absolutely nothing to anchor a branch to, fall back to synthetic task as last resort
    if (!chosenMs) {
      toProcess = [{ milestone: null, task: { id: firstString(payload?.task_id, payload?.taskId, 't-synth') || 't-synth', name: firstString(payload?.task_name, 'task') || 'task', status: 'open' } }];
    }
  }

  for (const it of toProcess) {
    const selectedMilestone = it.milestone;
    const selectedTask = it.task;

  const milestoneName = firstString(selectedMilestone?.name, selectedMilestone?.title, 'Milestone');
  const milestoneNameText: string = milestoneName || 'Milestone';
  const milestoneSlug = toSlug(selectedMilestone?.slug, milestoneNameText || 'milestone');
  const taskName = firstString(selectedTask?.name, selectedTask?.title, selectedTask?.summary, selectedTask?.label, selectedTask?.key, selectedTask?.id) || null;
  const rawTaskSlug = taskName ? slugify(taskName) : null;
  // If we're operating on a synthetic fallback (no real task), avoid feat/task; prefer milestone/project instead
  const isSynthetic = !selectedTask || firstString(selectedTask?.id) === 't-synth';
  const taskSlug = isSynthetic ? null : rawTaskSlug;
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
  const readHeadSha = async (remote?: boolean) => {
    try {
      return await H.getBranchHeadSha({ repoRoot, branch: branchName, remote });
    } catch (err) {
      logger.debug('coordinator: getBranchHeadSha failed', { workflowId, branchName, remote: !!remote, error: err });
      return null;
    }
  };
  let lastLocalHead = await readHeadSha(false);
  let lastRemoteHead = await readHeadSha(true);
  const verifyRemoteDiffOrAbort = async (phase: string, extras?: Record<string, any>) => {
    const phaseKey = phase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'phase';
    logger.info('coordinator: verifying commit state', {
      workflowId,
      phase: phaseKey,
      branchName,
      baseBranch,
      lastLocalHead,
      lastRemoteHead,
      taskId: taskDescriptor?.id || null
    });
    const localAfter = await readHeadSha(false);
    if (!localAfter) {
      logger.error('coordinator: unable to read branch head after phase', {
        workflowId,
        phase: phaseKey,
        branchName,
        baseBranch,
        taskId: taskDescriptor?.id || null,
        extras: extras || null
      });
      await recordDiagnostic(`coordinator-${phaseKey}-head-unreadable.json`, {
        workflowId,
        branchName,
        baseBranch,
        taskId: taskDescriptor?.id || null,
        lastLocalHead,
        extras
      });
      throw new Error(`Coordinator-critical: ${phase} could not read branch head. Aborting.`);
    }
    if (lastLocalHead && localAfter === lastLocalHead) {
      logger.error('coordinator: branch head unchanged after phase', {
        workflowId,
        phase: phaseKey,
        branchName,
        baseBranch,
        taskId: taskDescriptor?.id || null,
        lastLocalHead,
        extras: extras || null
      });
      await recordDiagnostic(`coordinator-${phaseKey}-no-new-commit.json`, {
        workflowId,
        branchName,
        baseBranch,
        taskId: taskDescriptor?.id || null,
        lastLocalHead,
        localAfter,
        extras
      });
      throw new Error(`Coordinator-critical: ${phase} did not create a new commit. Aborting.`);
    }
    try {
      const verification = await H.verifyRemoteBranchHasDiff({ repoRoot, branch: branchName, baseBranch });
      if (!verification || !verification.hasDiff) {
        logger.error('coordinator: remote diff verification failed', {
          workflowId,
          phase: phaseKey,
          branchName,
          baseBranch,
          taskId: taskDescriptor?.id || null,
          verification: verification || null,
          extras: extras || null
        });
        await recordDiagnostic(`coordinator-${phaseKey}-no-remote-diff.json`, {
          workflowId,
          branchName,
          baseBranch,
          taskId: taskDescriptor?.id || null,
          verification,
          extras
        });
        throw new Error(`Coordinator-critical: ${phase} produced no remote diff. Aborting.`);
      }
      const remoteBefore = lastRemoteHead;
      let remoteAfter = verification.branchSha || null;
      if (!remoteAfter) remoteAfter = await readHeadSha(true);
      if (!remoteAfter) {
        logger.error('coordinator: remote head unreadable after phase', {
          workflowId,
          phase: phaseKey,
          branchName,
          baseBranch,
          taskId: taskDescriptor?.id || null,
          verification,
          extras: extras || null
        });
        await recordDiagnostic(`coordinator-${phaseKey}-remote-head-unreadable.json`, {
          workflowId,
          branchName,
          baseBranch,
          taskId: taskDescriptor?.id || null,
          verification,
          extras
        });
        throw new Error(`Coordinator-critical: ${phase} could not verify remote commit. Aborting.`);
      }
      if (remoteBefore && remoteAfter === remoteBefore) {
        logger.error('coordinator: remote head unchanged after phase', {
          workflowId,
          phase: phaseKey,
          branchName,
          baseBranch,
          taskId: taskDescriptor?.id || null,
          remoteBefore,
          remoteAfter,
          extras: extras || null
        });
        await recordDiagnostic(`coordinator-${phaseKey}-remote-head-unchanged.json`, {
          workflowId,
          branchName,
          baseBranch,
          taskId: taskDescriptor?.id || null,
          remoteBefore,
          remoteAfter,
          verification,
          extras
        });
        throw new Error(`Coordinator-critical: ${phase} did not push a new remote commit. Aborting.`);
      }
      logger.info('coordinator: remote diff verified', {
        workflowId,
        phase: phaseKey,
        branchName,
        baseBranch,
        aheadCount: verification.aheadCount ?? null,
        diffSummary: (verification.diffSummary || '').slice(0, 400)
      });
      lastLocalHead = localAfter;
      lastRemoteHead = remoteAfter;
      return verification;
    } catch (err: any) {
      if (err && typeof err.message === 'string' && err.message.includes('Coordinator-critical')) throw err;
      const errorMessage = err?.message || String(err);
      logger.warn('coordinator: remote diff verification error', {
        workflowId,
        phase: phaseKey,
        branchName,
        baseBranch,
        taskId: taskDescriptor?.id || null,
        error: errorMessage,
        extras: extras || null
      });
      await recordDiagnostic(`coordinator-${phaseKey}-verify-error.json`, {
        workflowId,
        branchName,
        baseBranch,
        taskId: taskDescriptor?.id || null,
        lastLocalHead,
        lastRemoteHead,
        error: errorMessage,
        extras
      });
      throw new Error(`Coordinator-critical: ${phase} verification failed. ${errorMessage}`);
    }
  };
  const leadOutcome = await H.runLeadCycle(r, workflowId, projectId, projectInfo, projectSlug, repoRemote, branchName, baseBranch, milestoneDescriptor, milestoneNameText, milestoneSlug, taskDescriptor, taskName, feedbackNotes, attempt);

    // Try to apply edits whenever the lead outcome contains a diff or structured ops
    // even if the lead did not apply the edits itself.
    let appliedSomething = false;
    try {
      if (logger.debug) logger.debug('leadOutcome', { taskId: taskDescriptor?.id, leadOutcome: (leadOutcome && typeof leadOutcome === 'object') ? { success: !!leadOutcome.success, noChanges: !!leadOutcome.noChanges } : leadOutcome });
      if (taskDescriptor && taskDescriptor.id && leadOutcome) {
        const result = await applyAgentCodeChanges({
          workflowId,
          phase: 'lead',
          repoRoot,
          branchName,
          baseBranch,
          agentResult: leadOutcome,
          taskDescriptor,
          taskName,
          messages: {
            noOps: 'Coordinator-critical: lead engineer returned no diff operations to apply. Aborting.',
            noChanges: 'Coordinator-critical: lead engineer edits produced no file changes. Aborting.',
            commitFailed: 'Coordinator-critical: lead engineer changes were not pushed to the remote. Aborting.',
          },
          commitMessage: `feat: ${taskName}`,
          parseAgentEditsFromResponse,
          parseUnifiedDiffToEditSpec: (txt: string) => H.parseUnifiedDiffToEditSpec(txt),
          applyEditOps: H.applyEditOps,
          ensureBranchPublished: H.ensureBranchPublished,
          commitAndPushPaths: H.commitAndPushPaths,
          recordDiagnostic,
          verifyCommitState: verifyRemoteDiffOrAbort,
          logger,
        });
        if (result.applied || result.upstreamApplied) appliedSomething = true;
      }
    } catch (err) {
      logger.warn('coordinator: failed to apply lead-engineer diff/edit spec', { workflowId, error: err });
      throw err;
    }

    if (taskDescriptor && (taskDescriptor.id || taskDescriptor.external_id) && (appliedSomething || (leadOutcome && leadOutcome.success))) {
      try {
        const key = String(taskDescriptor.external_id || taskDescriptor.id || '');
        if (!key || key === 't-synth') {
          logger.debug('coordinator: skipping updateTaskStatus; synthetic or missing task id', { workflowId, taskId: taskDescriptor?.id, external_id: taskDescriptor?.external_id });
        } else {
          const updateRes = await H.updateTaskStatus(key, 'done');
          if (!(updateRes && updateRes.ok)) logger.warn('coordinator: updateTaskStatus returned not-ok', { workflowId, taskKey: key });
        }
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
        // Iterative evaluator loop: evaluate -> feedback -> revise up to cfg.planMaxIterationsPerStage
        const maxIters = (cfg.planMaxIterationsPerStage === null || cfg.planMaxIterationsPerStage === undefined)
          ? 5
          : Number(cfg.planMaxIterationsPerStage) || 5;
        let currentPlan = mini.plannerResult;
        let approved = false;
        const planHistory: Array<{ attempt: number; payload: any }> = [];
        for (let i = 0; i < maxIters; i++) {
          const evaluationCorrId = randomUUID();
          await persona.sendPersonaRequest(r, {
            workflowId,
            toPersona: PERSONAS.PLAN_EVALUATOR,
            step: i === 0 ? "3.5-evaluate-qa-plan" : "3.7-evaluate-qa-plan-revised",
            intent: "evaluate_plan_relevance",
            payload: {
              qa_feedback: qaResult,
              plan: currentPlan,
              require_citations: cfg.planRequireCitations,
              citation_fields: cfg.planCitationFields,
              uncited_budget: cfg.planUncitedBudget,
              treat_uncited_as_invalid: cfg.planTreatUncitedAsInvalid
            },
            corrId: evaluationCorrId,
            repo: repoRemote,
            branch: branchName,
            projectId
          });
          const evalEvent = await persona.waitForPersonaCompletion(r, PERSONAS.PLAN_EVALUATOR, workflowId, evaluationCorrId);
          const evalStatus = persona.interpretPersonaStatus(evalEvent.fields.result);
          if (evalStatus.status !== 'fail') { approved = true; break; }
          const evalObj = persona.parseEventResult(evalEvent.fields.result);
          // Feed evaluator feedback back to planner with explicit plan_feedback and history
          const evalReason = (evalObj && (evalObj.reason || evalObj.details || evalObj.message)) || '';
          const planFeedbackText = [
            'The proposed plan did not pass evaluation.',
            evalReason ? `Evaluator Feedback: ${evalReason}` : undefined,
            qaResult ? `QA Feedback Summary: ${typeof qaResult === 'string' ? qaResult.slice(0, 500) : (JSON.stringify(qaResult).slice(0, 500))}` : undefined,
          ].filter(Boolean).join('\n');
          planHistory.push({ attempt: i + 1, payload: currentPlan });
          const revCorr = randomUUID();
          await persona.sendPersonaRequest(r, {
            workflowId,
            toPersona: PERSONAS.IMPLEMENTATION_PLANNER,
            step: "3.6-plan-revision",
            intent: "revise_plan",
            payload: {
              qa_feedback: qaResult?.payload ?? qaResult,
              evaluator_feedback: evalObj,
              previous_plan: currentPlan,
              // planner parity with initial planning loop: include feedback and plan_feedback
              feedback: planFeedbackText,
              plan_feedback: planFeedbackText,
              plan_request: { attempt: i + 1, requires_approval: true, revision: i },
              plan_history: planHistory.slice(),
              // Ask the planner to restate the evaluator feedback verbatim so we can validate it was seen
              require_acknowledged_feedback: true,
              acknowledge_key: "acknowledged_feedback",
              // Explicit prioritization flags and structured revision requirements
              prioritize_evaluator_feedback: true,
              evaluator_feedback_text: evalReason || (typeof evalObj === 'string' ? String(evalObj) : JSON.stringify(evalObj || {})),
              revision_guidelines: [
                "Only include steps that directly address evaluator comments and QA failures.",
                "Keep steps small, verifiable, and cite the failing test, error, or acceptance criteria they address.",
                "Remove unrelated or speculative work.",
                "Update the plan until the evaluator would pass it as relevant and sufficient."
              ].join("\n"),
              require_plan_changes_mapping: true,
              mapping_key: "plan_changes_mapping",
              mapping_instructions: "Provide an array 'plan_changes_mapping' where each item maps one evaluator point to concrete plan changes (fields: evaluator_point, change, justification).",
              strict_relevance: true,
              // Relevance budget: require citations with budget for uncited steps
              require_citations: cfg.planRequireCitations,
              citation_fields: cfg.planCitationFields,
              uncited_budget: cfg.planUncitedBudget,
              treat_uncited_as_invalid: cfg.planTreatUncitedAsInvalid,
              guidance: "Revise the plan to directly address evaluator concerns; ensure each step maps to a failing test or acceptance criterion and is small and verifiable. Include a field 'acknowledged_feedback' that repeats the evaluator feedback you received, and briefly describe how each change addresses it."
            },
            corrId: revCorr,
            repo: repoRemote,
            branch: branchName,
            projectId
          });
          const revEvent = await persona.waitForPersonaCompletion(r, PERSONAS.IMPLEMENTATION_PLANNER, workflowId, revCorr);
          currentPlan = persona.parseEventResult(revEvent.fields.result);
          try {
            const ack = (currentPlan && ((currentPlan as any).acknowledged_feedback || (currentPlan as any)?.payload?.acknowledged_feedback)) || null;
            if (ack) {
              const preview = typeof ack === 'string' ? String(ack).slice(0, 500) : JSON.stringify(ack).slice(0, 500);
              logger.info("planner acknowledged evaluator feedback", { workflowId, preview });
            } else {
              logger.info("planner did not include acknowledged_feedback field", { workflowId });
            }
          } catch {}
        }
        if (!approved) {
          logger.warn("qa follow-up plan not approved within iteration limit; proceeding with latest plan to engineer", { workflowId, maxIters });
          try {
            // mark plan as unapproved but usable
            if (currentPlan && typeof currentPlan === 'object') {
              const obj = currentPlan as any;
              if (obj && typeof obj === 'object') {
                if (!obj.meta) obj.meta = {};
                obj.meta.plan_approved = false;
                obj.meta.reason = 'iteration_limit_exceeded';
              }
            }
          } catch {}
          (mini as any).plannerResult = currentPlan;
        } else {
          (mini as any).plannerResult = currentPlan;
          try {
            if ((mini as any).plannerResult && typeof (mini as any).plannerResult === 'object') {
              const obj = (mini as any).plannerResult as any;
              if (!obj.meta) obj.meta = {};
              obj.meta.plan_approved = true;
            }
          } catch {}
        }

        // forward to implementation planning if evaluator ultimately passes
        try {
          const implCorr = randomUUID();
          const implPersona = cfg.allowedPersonas.includes(PERSONAS.IMPLEMENTATION_PLANNER) ? PERSONAS.IMPLEMENTATION_PLANNER : PERSONAS.LEAD_ENGINEER;
          if (mini.plannerResult) await H.persona.sendPersonaRequest(r, {
            workflowId,
            toPersona: implPersona,
            step: "4-implementation-plan",
            intent: "handle_qa_followups",
            payload: { qa_result: qaResult?.payload ?? qaResult, planner_result: mini.plannerResult, plan_approved: approved, created_tasks: mini.created, milestone: milestoneDescriptor, task: taskDescriptor, project_id: projectId },
            corrId: implCorr,
            repo: repoRemote,
            branch: branchName,
            projectId
          });
        } catch (err) {
          logger.warn("failed to forward mini planner result to implementation persona", { workflowId, error: err });
        }

        // If we have an approved plannerResult, route to lead-engineer to actually execute the plan
        if (mini.plannerResult) {
          try {
            const execCorr = randomUUID();
            await H.persona.sendPersonaRequest(r, {
              workflowId,
              toPersona: PERSONAS.LEAD_ENGINEER,
              step: "4.6-implementation-execute",
              intent: "implement_qa_followups",
              payload: {
                repo: repoRemote,
                branch: branchName,
                project_id: projectId,
                milestone: milestoneDescriptor,
                task: taskDescriptor,
                approved_plan: mini.plannerResult?.payload ?? mini.plannerResult,
                approved_plan_steps: (mini.plannerResult?.payload?.plan || mini.plannerResult?.plan || mini.plannerResult?.steps || null),
                plan_text: (mini.plannerResult?.output || null),
                plan_approved: approved,
                created_tasks: mini.created,
                stage: 'qa'
              },
              corrId: execCorr,
              repo: repoRemote,
              branch: branchName,
              projectId
            });
            const execEvent = await H.persona.waitForPersonaCompletion(r, PERSONAS.LEAD_ENGINEER, workflowId, execCorr);
            logger.info('qa-exec: received lead-engineer completion', { workflowId, execCorr, eventId: execEvent.id });
            const execResult = H.persona.parseEventResult(execEvent.fields.result);
            logger.info('qa-exec: parsed lead-engineer result', { workflowId, execCorr, resultType: typeof execResult, hasResult: !!execResult });
            // Attempt to apply edits if present, similar to the main lead cycle
            let execApplied = false;
            try {
              logger.info('qa-exec: checking conditions', { workflowId, hasTaskDescriptor: !!taskDescriptor, taskId: taskDescriptor?.id, hasExecResult: !!execResult });
              if (taskDescriptor && taskDescriptor.id && execResult) {
                logger.info('qa-exec: conditions met, processing result', { workflowId, taskId: taskDescriptor.id });
                const result = await applyAgentCodeChanges({
                  workflowId,
                  phase: 'qa-followup',
                  repoRoot,
                  branchName,
                  baseBranch,
                  agentResult: execResult,
                  taskDescriptor,
                  taskName: taskName || taskDescriptor?.name || 'qa follow-ups',
                  messages: {
                    noOps: 'Coordinator-critical: QA follow-up execution returned no diff operations. Aborting.',
                    noChanges: 'Coordinator-critical: QA follow-up edits produced no file changes. Aborting.',
                    commitFailed: 'Coordinator-critical: QA follow-up changes were not pushed to the remote. Aborting.',
                  },
                  parseAgentEditsFromResponse,
                  parseUnifiedDiffToEditSpec: (txt: string) => H.parseUnifiedDiffToEditSpec(txt),
                  applyEditOps: H.applyEditOps,
                  ensureBranchPublished: H.ensureBranchPublished,
                  commitAndPushPaths: H.commitAndPushPaths,
                  commitMessage: `fix(qa): ${taskName || taskDescriptor?.name || 'qa follow-ups'}`,
                  recordDiagnostic,
                  verifyCommitState: verifyRemoteDiffOrAbort,
                  logger,
                });
                execApplied = result.applied || result.upstreamApplied;
              }
            } catch (err) {
              logger.warn('qa-exec: failed to apply lead-engineer diff/edit spec', { workflowId, error: err });
              throw err;
            }

            // Optionally mark original task done if edits applied successfully
            if (taskDescriptor && (taskDescriptor.id || taskDescriptor.external_id) && execApplied) {
              try {
                const key = String(taskDescriptor.external_id || taskDescriptor.id || '');
                if (key && key !== 't-synth') {
                  const updateRes = await H.updateTaskStatus(key, 'done');
                  if (!(updateRes && updateRes.ok)) logger.warn('qa-exec: updateTaskStatus returned not-ok', { workflowId, taskKey: key });
                }
              } catch (err) {
                logger.warn('qa-exec: failed to mark task done after execution/apply', { workflowId, taskId: taskDescriptor?.id, error: err });
              }
            }
          } catch (err) {
            logger.warn('qa-exec: failed to route plan to lead-engineer or execute', { workflowId, error: String(err) });
          }
        }
      }

  // Also route via project-manager for additional follow-ups, but prevent runaway new QA tasks
      // Gate PM entirely when a canonical QA follow-up already exists for this parent task
      const existingQaExternalId = computeQaFollowupExternalId(projectId, taskDescriptor);
      let qaAnchorExists: boolean = false;
      try {
        const resolved = await findTaskIdByExternalId(existingQaExternalId, projectId);
        qaAnchorExists = !!resolved;
      } catch {}
      if (qaAnchorExists) {
        logger.info("coordinator: PM gating active; existing QA follow-up detected — skipping PM routing entirely", { workflowId, externalId: existingQaExternalId });
      } else {
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
}

export { extractDiffCandidates } from "./helpers/agentResponseParser.js";
export default { handleCoordinator };
