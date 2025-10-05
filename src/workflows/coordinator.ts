
import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { fetchProjectStatus, fetchProjectStatusDetails, fetchProjectNextAction } from "../dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, checkoutBranchFromBase, ensureBranchPublished } from "../gitUtils.js";
import { logger } from "../logger.js";
import { selectNextMilestone, deriveMilestoneContext } from "../milestones/milestoneManager.js";
import { selectNextTask, deriveTaskContext, pickSuggestion, normalizeTaskStatus } from "../tasks/taskManager.js";
import { firstString, slugify, normalizeRepoPath } from "../util.js";
import { waitForPersonaCompletion, sendPersonaRequest, parseEventResult, interpretPersonaStatus } from "../agents/persona.js";
import { createDashboardTaskEntriesWithSummarizer } from "../tasks/taskManager.js";
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
    if (!selectedTask) {
      const suggested = pickSuggestion(nextActionData?.suggestions);
      if (suggested) {
        selectedTask = suggested;
        logger.info("coordinator selected suggestion task", { workflowId, task: suggested.name, reason: suggested.summary });
      }
    }
  
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
    await sendPersonaRequest(r, {
      workflowId,
      toPersona: "context",
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
  
    const contextEvent = await waitForPersonaCompletion(r, "context", workflowId, contextCorrId);
    const contextResult = parseEventResult(contextEvent.fields.result);
    logger.info("coordinator received context completion", { workflowId, corrId: contextCorrId, eventId: contextEvent.id });

    let feedbackNotes: string[] = [];
    let attempt = 0;
    const leadOutcome = await runLeadCycle(r, workflowId, projectId, projectInfo, projectSlug, repoRemote, branchName, baseBranch, milestoneDescriptor, milestoneName, milestoneSlug, taskDescriptor, taskName, feedbackNotes, attempt);

    // After lead cycle, run QA tests by invoking the tester-qa persona. If QA fails,
    // request the project-manager to return follow-up task definitions. The coordinator
    // will then run summarizer -> create -> set-status for each follow-up and block
    // until creation+status succeed before forwarding to implementation planning.
    try {
      // Try to discover test/lint commands from package.json in the repo root
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
      await sendPersonaRequest(r, {
        workflowId,
        toPersona: "tester-qa",
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

      const qaEvent = await waitForPersonaCompletion(r, "tester-qa", workflowId, qaCorr);
      const qaResult = parseEventResult(qaEvent.fields.result);
      const qaStatus = interpretPersonaStatus(qaEvent.fields.result);
      logger.info("coordinator received QA completion", { workflowId, qaStatus: qaStatus.status, corrId: qaCorr, eventId: qaEvent.id });

      if (qaStatus.status === "fail") {
        // Ask project-manager to route the QA failure into tasks to create
        // But first, if the QA persona flagged an immediate action (e.g. missing tests/framework),
        // create that follow-up immediately and block until it's created and assigned.
        try {
          const qaPayloadObj = (qaResult && typeof qaResult === 'object') ? qaResult.payload ?? qaResult : null;
          const immediate = qaPayloadObj?.immediate_action || qaPayloadObj?.immediateAction || null;
          if (immediate && typeof immediate === 'string' && immediate.trim().length) {
            const suggested = [{ title: `QA immediate action: ${immediate.slice(0, 120)}`, description: `Immediate action requested by QA: ${immediate}`, schedule: 'urgent', assigneePersona: 'implementation-planner' }];
            await handleFailureMiniCycle(r, workflowId, 'qa', suggested, {
              repo: repoRemote,
              branch: branchName,
              projectId,
              milestoneDescriptor,
              parentTaskDescriptor: taskDescriptor,
              projectName: projectInfo?.name || null,
              scheduleHint: payloadObj?.scheduleHint
            });
            // After handling immediate action, continue to request project-manager suggestions for any other follow-ups
          }
        } catch (err) {
          logger.warn("coordinator immediate QA follow-up handling failed", { workflowId, error: err });
        }
        const pmCorr = randomUUID();
        await sendPersonaRequest(r, {
          workflowId,
          toPersona: "project-manager",
          step: "3-route",
          intent: "route_qa_followups",
          payload: { qa_result: qaResult?.payload ?? qaResult ?? qaEvent.fields.result, project_id: projectId, milestone: milestoneDescriptor, task: taskDescriptor },
          corrId: pmCorr,
          repo: repoRemote,
          branch: branchName,
          projectId
        });

        const pmEvent = await waitForPersonaCompletion(r, "project-manager", workflowId, pmCorr);
        const pmResult = parseEventResult(pmEvent.fields.result) || {};
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
        } else {
            // Use the helper to perform summarizer->create->set-status and forwarding according to stage policy
            const mini = await handleFailureMiniCycle(r, workflowId, 'qa', suggestedTasks, {
              repo: repoRemote,
              branch: branchName,
              projectId,
              milestoneDescriptor,
              parentTaskDescriptor: taskDescriptor,
              projectName: projectInfo?.name || null,
              scheduleHint: payloadObj?.scheduleHint
            });

            if (mini && mini.plannerResult) {
              logger.info("coordinator received planner result", { workflowId, planner: mini.plannerResult });
              // If planner returned an actionable plan, forward it to the implementation planning step
              try {
                const implCorr = randomUUID();
                const implPersona = cfg.allowedPersonas.includes('implementation-planner') ? 'implementation-planner' : 'lead-engineer';
                await sendPersonaRequest(r, {
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
    } catch (err) {
      logger.warn("QA stage handling failed", { workflowId, error: err });
      throw err;
    }
}
