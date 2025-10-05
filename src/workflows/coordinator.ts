import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { fetchProjectStatus, fetchProjectStatusDetails, fetchProjectNextAction } from "../dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, checkoutBranchFromBase, ensureBranchPublished, commitAndPushPaths } from "../gitUtils.js";
import { logger } from "../logger.js";
import { selectNextMilestone, deriveMilestoneContext } from "../milestones/milestoneManager.js";
import { selectNextTask, deriveTaskContext, pickSuggestion, normalizeTaskStatus } from "../tasks/taskManager.js";
import { firstString, slugify, normalizeRepoPath } from "../util.js";
import * as persona from "../agents/persona.js";
import { PERSONAS } from "../personaNames.js";
import { createDashboardTaskEntriesWithSummarizer } from "../tasks/taskManager.js";
import { applyEditOps } from "../fileops.js";
import { updateTaskStatus } from "../dashboard.js";
import { handleFailureMiniCycle } from "./helpers/stageHelpers.js";
import { runLeadCycle } from "./stages/implementation.js";

export async function handleCoordinator(r: any, msg: any, payloadObj: any) {
    const workflowId = msg.workflow_id;
    const projectId = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id);
    if (!projectId) throw new Error("Coordinator requires project_id in payload or message");
  
    let projectInfo: any = await fetchProjectStatus(projectId);
    let projectStatus: any = await fetchProjectStatusDetails(projectId);
    let nextActionData: any = await fetchProjectNextAction(projectId);
    const projectSlug = firstString(payloadObj.project_slug, payloadObj.projectSlug, projectInfo?.slug, projectInfo?.id);
    const projectRepo = firstString(
      payloadObj.repo,
      payloadObj.repository,
      typeof projectInfo?.repository === "string" ? projectInfo.repository : null,
      projectInfo?.repository?.url,
      projectInfo?.repository?.remote,
      projectInfo?.repo?.url,
      projectInfo?.repo_url,
      projectInfo?.git_url,
      Array.isArray(projectInfo?.repositories) ? projectInfo.repositories[0]?.url : null
    );
  
    if (!projectRepo) {
      logger.error("coordinator abort: project repository missing", { workflowId, projectId });
      throw new Error(`Project ${projectId} has no repository associated`);
    }
  
    if (!payloadObj.repo) payloadObj.repo = projectRepo;
    if (!payloadObj.project_slug && projectSlug) payloadObj.project_slug = projectSlug;
    if (!payloadObj.project_name && projectInfo?.name) payloadObj.project_name = projectInfo.name;
  
    const repoResolution = await resolveRepoFromPayload(payloadObj);
    const repoRoot = normalizeRepoPath(repoResolution.repoRoot, cfg.repoRoot);
    const repoMeta = await getRepoMetadata(repoRoot);
  
    const baseBranch = firstString(
      payloadObj.base_branch,
      payloadObj.branch,
      repoResolution.branch,
      repoMeta.currentBranch,
      cfg.git.defaultBranch
    ) || cfg.git.defaultBranch;
  
  
  
    // The coordinator will loop: select the next milestone/task, run the lead -> QA flow,
    // and then re-evaluate project state until there are no remaining open tasks or a safety limit is reached.
    const MAX_ITERATIONS = 50;
  let iterations = 0;
  const processedTaskIds = new Set<string>();

    while (iterations < MAX_ITERATIONS) {
      iterations += 1;

  // iteration tracing via logger
  try { if (logger.debug) logger.debug(`coordinator loop iter=${iterations}`); } catch (e) {}

      // refresh project state each iteration so selection sees the latest dashboard
      projectInfo = await fetchProjectStatus(projectId);
      projectStatus = await fetchProjectStatusDetails(projectId);
      nextActionData = await fetchProjectNextAction(projectId);

      const milestoneSource = projectStatus ?? projectInfo;
      let selectedMilestone = (payloadObj.milestone && typeof payloadObj.milestone === "object")
        ? payloadObj.milestone
        : selectNextMilestone(milestoneSource);

      if (!selectedMilestone && projectInfo && projectInfo !== milestoneSource) {
        selectedMilestone = selectNextMilestone(projectInfo) || selectedMilestone;
      }

      if (!selectedMilestone && milestoneSource && typeof milestoneSource === "object") {
        const explicit = (milestoneSource as any).next_milestone ?? (milestoneSource as any).nextMilestone;
        if (explicit && typeof explicit === "object") selectedMilestone = explicit;
      }

      if (!selectedMilestone) {
        logger.warn("coordinator milestone fallback", { workflowId, projectId });
      }

      const milestoneName = firstString(
        payloadObj.milestone_name,
        selectedMilestone?.name,
        selectedMilestone?.title,
        selectedMilestone?.goal,
        (milestoneSource as any)?.next_milestone?.name,
        (milestoneSource as any)?.nextMilestone?.name,
        projectInfo?.next_milestone?.name,
        "next milestone"
      )!;

      const milestoneSlug = slugify(
        firstString(
          payloadObj.milestone_slug,
          selectedMilestone?.slug,
          milestoneName,
          "milestone"
        )!
      );

      let selectedTask = selectNextTask(selectedMilestone, milestoneSource, projectStatus, projectInfo, payloadObj);
      // If selectNextTask returned a task we've already processed in this coordinator run, skip it
      if (selectedTask && selectedTask.id && processedTaskIds.has(String(selectedTask.id))) {
        selectedTask = null;
      }
      if (!selectedTask) {
        const suggested = pickSuggestion(nextActionData?.suggestions);
        if (suggested) {
          selectedTask = suggested;
          logger.info("coordinator selected suggestion task", { workflowId, task: suggested.name, reason: suggested.summary });
        }
      }


      // If nothing to do from the milestone selection, try to fall back to any open project task
      const projNow = await fetchProjectStatus(projectId) as any;
      const remainingNow = Array.isArray(projNow?.tasks) ? projNow.tasks.length : 0;
      if (!selectedTask && remainingNow) {
        // try to pick any open task from the project-level status; prefer the first unprocessed task
        try {
          if (Array.isArray(projNow?.tasks)) {
            for (const t of projNow.tasks) {
              const tid = firstString(t?.id, t?.key) || null;
              if (!tid) continue;
              if (processedTaskIds.has(String(tid))) continue;
              // skip completed tasks
              const ns = normalizeTaskStatus(t?.status ?? t?.state ?? t?.progress);
              if (ns === 'done' || ns === 'completed' || ns === 'closed') continue;
              selectedTask = t;
              logger.info('coordinator selected project-level unprocessed task', { workflowId, taskId: tid, taskName: t?.name || t?.title || null });
              break;
            }
          }
        } catch (err) {
          // fallback to original selector if anything goes wrong
          const fallback = selectNextTask(projNow);
          if (fallback && (!fallback.id || !processedTaskIds.has(String(fallback.id)))) {
            selectedTask = fallback;
            logger.info('coordinator selected fallback project-level task', { workflowId, taskId: fallback.id || null, taskName: fallback?.name || fallback?.title || null });
          }
        }
      }

      // If we've selected a task, mark it as in-progress/processed early to avoid re-selection
      try {
        if (selectedTask && selectedTask.id) {
          processedTaskIds.add(String(selectedTask.id));
          logger.debug('processedTaskIds preadd', { taskId: String(selectedTask.id), processedTaskIds: Array.from(processedTaskIds) });
        }
      } catch (err) {}

      // Optional debug: use logger.debug to record selection decision and project snapshot when needed
      try {
        if (logger.debug) {
          const projSnapshot = (projNow && Array.isArray((projNow as any).tasks)) ? (projNow as any).tasks.map((t: any) => ({ id: t.id, name: t.name, status: t.status })) : [];
          logger.debug('coordinator selection', { iteration: iterations, selectedTaskId: selectedTask?.id ?? null, remainingNow, projSnapshot, processedTaskIds: Array.from(processedTaskIds) });
        }
      } catch (err) {}

      if (!selectedTask && !remainingNow) {
        logger.info("coordinator: no selected task and no remaining tasks, finishing", { workflowId, projectId });
        break;
      }

  try { logger.info(`coordinator iteration=${iterations} selectedTask=${selectedTask?.id ?? selectedTask?.name ?? 'none'} remaining=${remainingNow}`); } catch (e) {}

      const taskName = firstString(
        payloadObj.task_name,
        selectedTask?.name,
        selectedTask?.title,
        selectedTask?.summary,
        selectedTask?.label,
        selectedTask?.key,
        selectedTask?.id
      ) || null;

      if (taskName && !payloadObj.task_name) payloadObj.task_name = taskName;

      const rawTaskSlug = firstString(
        payloadObj.task_slug,
        selectedTask?.slug,
        selectedTask?.key,
        taskName,
        selectedTask?.id,
        "task"
      );
      const taskSlug = rawTaskSlug ? slugify(rawTaskSlug) : null;

      const taskDueText = firstString(
        selectedTask?.due,
        selectedTask?.due_at,
        selectedTask?.dueAt,
        selectedTask?.due_date,
        selectedTask?.target_date,
        selectedTask?.targetDate,
        selectedTask?.deadline,
        selectedTask?.eta
      );

      const selectedTaskStatus = normalizeTaskStatus(
        selectedTask?.status ??
        selectedTask?.state ??
        selectedTask?.phase ??
        selectedTask?.stage ??
        selectedTask?.progress
      );

      const taskDescriptor = selectedTask
        ? {
            id: firstString(selectedTask.id, selectedTask.key, taskSlug, taskName) || null,
            name: taskName,
            slug: taskSlug,
            status: selectedTask?.status ?? selectedTask?.state ?? selectedTask?.progress ?? null,
            normalized_status: selectedTaskStatus || null,
            due: taskDueText || null,
            assignee: firstString(
              selectedTask?.assignee,
              selectedTask?.assignee_name,
              selectedTask?.assigneeName,
              selectedTask?.owner,
              selectedTask?.owner_name,
              selectedTask?.assigned_to,
              selectedTask?.assignedTo
            ) || null,
            branch: firstString(selectedTask?.branch, selectedTask?.branch_name, selectedTask?.branchName) || null,
            summary: firstString(selectedTask?.summary, selectedTask?.description) || null
          }
        : null;

      let branchName = payloadObj.branch_name
        || firstString(
          selectedMilestone?.branch,
          selectedMilestone?.branch_name,
          selectedMilestone?.branchName
        )
        || `milestone/${milestoneSlug}`;

      await checkoutBranchFromBase(repoRoot, baseBranch, branchName);
      logger.info("coordinator prepared branch", { workflowId, repoRoot, baseBranch, branchName });

      await ensureBranchPublished(repoRoot, branchName);
  
    const repoSlug = repoMeta.remoteSlug;
    const repoRemote = repoSlug ? `https://${repoSlug}.git` : (payloadObj.repo || projectRepo || repoMeta.remoteUrl || repoResolution.remote || "");
    if (!repoRemote) throw new Error("Coordinator could not determine repo remote");
  
    const milestoneDue = firstString(
      selectedMilestone?.due,
      selectedMilestone?.due_at,
      selectedMilestone?.dueAt,
      selectedMilestone?.due_date,
      selectedMilestone?.target_date,
      selectedMilestone?.targetDate,
      selectedMilestone?.deadline,
      selectedMilestone?.eta
    );
  
    const milestoneDescriptor = selectedMilestone
      ? {
          id: selectedMilestone.id ?? milestoneSlug,
          name: milestoneName,
          slug: milestoneSlug,
          status: selectedMilestone.status,
          goal: selectedMilestone.goal,
          due: milestoneDue || null,
          branch: firstString(selectedMilestone.branch, selectedMilestone.branch_name, selectedMilestone.branchName) || branchName,
          task: taskDescriptor
        }
      : (taskDescriptor ? { task: taskDescriptor } : null);
    const contextCorrId = randomUUID();
      await persona.sendPersonaRequest(r, {
      workflowId,
      toPersona: PERSONAS.CONTEXT,
      step: "1-context",
      intent: "hydrate_project_context",
      payload: {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        project_slug: projectSlug || undefined,
        project_name: payloadObj.project_name || projectInfo?.name || "",
        milestone: milestoneDescriptor,
        milestone_name: milestoneName,
        task: taskDescriptor,
        task_name: taskName || (taskDescriptor?.name ?? ""),
        upload_dashboard: true
      },
      corrId: contextCorrId,
      repo: repoRemote,
      branch: branchName,
      projectId
    });
  
    const contextEvent = await persona.waitForPersonaCompletion(r, PERSONAS.CONTEXT, workflowId, contextCorrId);
      const contextResult = persona.parseEventResult(contextEvent.fields.result);
    logger.info("coordinator received context completion", { workflowId, corrId: contextCorrId, eventId: contextEvent.id });

    let feedbackNotes: string[] = [];
    let attempt = 0;
      let leadOutcome: any = null;
      if (selectedTask) {
        leadOutcome = await runLeadCycle(r, workflowId, projectId, projectInfo, projectSlug, repoRemote, branchName, baseBranch, milestoneDescriptor, milestoneName, milestoneSlug, taskDescriptor, taskName, feedbackNotes, attempt);

        // If the lead cycle succeeded and we have a task identifier, mark the task done
        try {
          // Diagnostic: show leadOutcome so we can see if coordinator considers the lead successful
          if (logger.debug) logger.debug('leadOutcome', { taskId: taskDescriptor?.id, leadOutcome: (leadOutcome && typeof leadOutcome === 'object') ? { success: !!leadOutcome.success, noChanges: !!leadOutcome.noChanges } : leadOutcome });
          if (leadOutcome && leadOutcome.success && taskDescriptor && taskDescriptor.id) {
            if (leadOutcome.result) {
              const editResult = await applyEditOps(JSON.stringify(leadOutcome.result), { repoRoot, branchName });
              if (editResult.changed.length > 0) {
                await commitAndPushPaths({
                  repoRoot,
                  branch: branchName,
                  message: `feat: ${taskName}`,
                  paths: editResult.changed,
                });
              }
            }
            try {
              // Diagnostic: log intent to update task status
              if (logger.debug) logger.debug('about to updateTaskStatus', { taskId: String(taskDescriptor.id), workflowId });
              const updateRes = await updateTaskStatus(String(taskDescriptor.id), 'done');
              if (logger.debug) logger.debug('updateTaskStatus returned', { taskId: String(taskDescriptor.id), workflowId, ok: !!(updateRes && updateRes.ok) });
              // Only mark as processed if the dashboard update reported ok
              if (updateRes && updateRes.ok) {
                try {
                  if (taskDescriptor && taskDescriptor.id) {
                    processedTaskIds.add(String(taskDescriptor.id));
                    logger.debug('processedTaskIds added', { taskId: String(taskDescriptor.id), processedTaskIds: Array.from(processedTaskIds) });
                  }
                } catch (err) {
                  // ignore
                }
              }
            } catch (err) {
              logger.warn('coordinator: failed to mark task done after lead success', { workflowId, taskId: taskDescriptor.id, error: err });
            }
          }
        } catch (err) {
          // swallow non-fatal errors here to avoid breaking coordinator loop
          logger.debug('coordinator: error while attempting to update task status after lead', { workflowId, error: err });
        }
      } else {
        logger.info('coordinator: no selected task for this iteration, skipping lead cycle', { workflowId, projectId });
      }

      // If there was no selected task, skip QA and all subsequent stages for this iteration
      // The coordinator should only run QA/planning/implementation for an actively selected task.
      if (!selectedTask) {
        logger.info('coordinator: skipping QA and subsequent stages because no selected task', { workflowId, projectId });
        continue;
      }

    // After lead cycle, run QA tests by invoking the tester-qa persona. If QA fails,
    // request the project-manager to return follow-up task definitions. The coordinator
    // will then run summarizer -> create -> set-status for each follow-up and block
    // until creation+status succeed before forwarding to implementation planning.
    let testCommands: string[] = [];
    try {
      const pjPath = require('path').join(repoRoot, 'package.json');
      const pj = JSON.parse(await (await import('fs/promises')).readFile(pjPath, 'utf8'));
      const scripts = pj && pj.scripts ? pj.scripts : {};
      if (scripts.test) testCommands.push('npm test');
      if (scripts.lint) testCommands.push('npm run lint');
      // include explicit commands if present in scripts
      if (typeof scripts.test === 'string' && scripts.test.trim().length && scripts.test.trim() !== 'echo "Error: no test specified" && exit 1') {
        // prefer direct npm invocation
        // already added 'npm test'
      }
    } catch (err) {
      // ignore discovery errors - persona will be told if nothing available
    }

    const qaCorr = randomUUID();
      await persona.sendPersonaRequest(r, {
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
        commands: testCommands
      },
      corrId: qaCorr,
      repo: repoRemote,
      branch: branchName,
      projectId
    });

  const qaEvent = await persona.waitForPersonaCompletion(r, PERSONAS.TESTER_QA, workflowId, qaCorr);
      const qaResult = persona.parseEventResult(qaEvent.fields.result);
      const qaStatus = persona.interpretPersonaStatus(qaEvent.fields.result);
    logger.info("coordinator received QA completion", { workflowId, qaStatus: qaStatus.status, corrId: qaCorr, eventId: qaEvent.id });

    if (qaStatus.status === "fail") {
      // Any QA failure (not timeouts/system issues) is urgent: forward QA output to the summarizer -> create -> set-status flow
      const qaPayloadObj = (qaResult && typeof qaResult === 'object') ? qaResult.payload ?? qaResult : null;
      // Build suggested follow-ups from QA payload if present, otherwise synthesize one urgent follow-up using QA details
      let suggestedFromQa: any[] = [];
      if (qaPayloadObj) {
        const candidates = qaPayloadObj.tasks || qaPayloadObj.follow_ups || qaPayloadObj.suggestions || qaPayloadObj.backlog || null;
        if (Array.isArray(candidates) && candidates.length) {
          suggestedFromQa = candidates.map((t: any) => (typeof t === 'object' ? t : { title: String(t) }));
        }
      }
      // Fallback: synthesize a single urgent task using available QA details
      if (!suggestedFromQa.length) {
        const detailsText = (qaPayloadObj && (qaPayloadObj.details || qaPayloadObj.message)) || (typeof qaResult === 'string' ? qaResult : qaResult?.details) || qaEvent.fields.result || 'QA reported failures';
        const title = `QA failure: ${String(((detailsText || '') as string).split('\n')[0]).slice(0, 120)}`;
        suggestedFromQa = [{ title, description: String(detailsText).slice(0, 5000), schedule: 'urgent', assigneePersona: 'implementation-planner' }];
      }

      // Forward suggested QA follow-ups to the failure mini-cycle (summarizer -> create -> set-status -> planner) and block until handled
      const mini = await handleFailureMiniCycle(r, workflowId, 'qa', suggestedFromQa, {
        repo: repoRemote,
        branch: branchName,
        projectId,
        milestoneDescriptor,
        parentTaskDescriptor: taskDescriptor,
        projectName: projectInfo?.name || null,
        scheduleHint: payloadObj?.scheduleHint,
        qaResult: qaResult
      });

      if (mini && mini.plannerResult) {
        const evaluationCorrId = randomUUID();
        await persona.sendPersonaRequest(r, {
            workflowId,
            toPersona: PERSONAS.PLAN_EVALUATOR,
            step: "3.5-evaluate-qa-plan",
            intent: "evaluate_plan_relevance",
            payload: {
                qa_feedback: qaResult,
                plan: mini.plannerResult,
            },
            corrId: evaluationCorrId,
            repo: repoRemote,
            branch: branchName,
            projectId
        });
        const evaluationEvent = await persona.waitForPersonaCompletion(r, PERSONAS.PLAN_EVALUATOR, workflowId, evaluationCorrId);
        const evaluationStatus = persona.interpretPersonaStatus(evaluationEvent.fields.result);

        if (evaluationStatus.status !== 'pass') {
            throw new Error(`Plan was rejected by ${PERSONAS.PLAN_EVALUATOR}`);
        }

        // If evaluation passes, then send to implementation-planner
        try {
          const implCorr = randomUUID();
          const implPersona = cfg.allowedPersonas.includes('implementation-planner') ? 'implementation-planner' : 'lead-engineer';
          await persona.sendPersonaRequest(r, {
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

      // After immediate handling, still request project-manager routing for any additional follow-ups
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

const pmEvent = await persona.waitForPersonaCompletion(r, PERSONAS.PROJECT_MANAGER, workflowId, pmCorr);
  const pmResult = persona.parseEventResult(pmEvent.fields.result) || {};
      // prefer explicit payload fields that might contain suggested tasks
      let suggestedTasks = pmResult.payload?.tasks || pmResult.payload?.follow_ups || pmResult.payload?.backlog || pmResult.payload?.suggestions || pmResult.payload || null;
      if (!suggestedTasks) {
        // fallback to any task-like structure in QA result
        suggestedTasks = qaResult?.payload?.follow_ups || qaResult?.payload?.tasks || qaResult?.payload || [];
      }

      if (!Array.isArray(suggestedTasks)) {
        // If single object, wrap it
        if (suggestedTasks && typeof suggestedTasks === 'object') suggestedTasks = [suggestedTasks];
        else suggestedTasks = [];
      }

      if (!suggestedTasks.length) {
        logger.warn("project-manager returned no suggested tasks for QA failure", { workflowId, projectId });
        // Try to synthesize an urgent follow-up when QA or PM details indicate missing tests or framework
        try {
          const pmDetails = (pmResult && typeof pmResult === 'object') ? (pmResult.payload?.details || pmResult.details || '') : '';
          const qaDetailsText = (qaResult && typeof qaResult === 'object') ? (qaResult.payload?.details || qaResult.details || '') : '';
          const combined = ((pmDetails || '') + '\n' + (qaDetailsText || '')).toLowerCase();
          const missingSignals = ['no test', 'no tests', 'no test commands', 'no testing framework', 'no obvious testing framework', 'add jest', 'add pytest', 'missing tests', 'no pytest', 'no jest', 'no test script'];
          const found = missingSignals.find(sig => combined.includes(sig));
          if (found) {
            const reason = pmDetails || qaDetailsText || 'QA reported missing tests or test framework.';
            const synthesized = [{ title: `Add test harness / test scripts`, description: `Urgent: ${reason}`, schedule: 'urgent', assigneePersona: 'implementation-planner' }];
            logger.info("coordinator synthesizing urgent QA follow-up task", { workflowId, reason: found });
            // Use the same create+status+planner blocking flow
            await handleFailureMiniCycle(r, workflowId, 'qa', synthesized, {
              repo: repoRemote,
              branch: branchName,
              projectId,
              milestoneDescriptor,
              parentTaskDescriptor: taskDescriptor,
              projectName: projectInfo?.name || null,
              scheduleHint: payloadObj?.scheduleHint
            });
            // After synthesizing and handling the immediate follow-up, there is nothing further to do here
            suggestedTasks = synthesized;
          }
        } catch (err) {
          logger.warn("coordinator failed to synthesize QA follow-up", { workflowId, error: err });
        }
      } else {
          // Use the helper to perform summarizer->create->set-status and forwarding according to stage policy
          const mini = await handleFailureMiniCycle(r, workflowId, 'qa', suggestedTasks, {
            repo: repoRemote,
            branch: branchName,
            projectId,
            milestoneDescriptor,
            parentTaskDescriptor: taskDescriptor,
            projectName: projectInfo?.name || null,
            scheduleHint: payloadObj?.scheduleHint,
            qaResult: qaResult
          });

          if (mini && mini.plannerResult) {
            logger.info("coordinator received planner result", { workflowId, planner: mini.plannerResult });
            // If planner returned an actionable plan, forward it to the implementation planning step
            try {
              const implCorr = randomUUID();
              const implPersona = cfg.allowedPersonas.includes(PERSONAS.IMPLEMENTATION_PLANNER) ? PERSONAS.IMPLEMENTATION_PLANNER : PERSONAS.LEAD_ENGINEER;
                await persona.sendPersonaRequest(r, {
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
              logger.warn("failed to forward planner result to implementation persona", { workflowId, error: err });
            }
          }
      }
    }
  }
}

// end handleCoordinator