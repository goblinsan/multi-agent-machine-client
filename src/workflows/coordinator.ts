
import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { makeRedis } from "../redisClient.js";
import { RequestSchema } from "../schema.js";
import { SYSTEM_PROMPTS } from "../personas.js";
import { callLMStudio } from "../lmstudio.js";
import { fetchContext, recordEvent, uploadContextSnapshot, fetchProjectStatus, fetchProjectStatusDetails, fetchProjectNextAction, fetchProjectStatusSummary, createDashboardTask, updateTaskStatus } from "../dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, commitAndPushPaths, checkoutBranchFromBase, ensureBranchPublished, runGit } from "../gitUtils.js";
import { logger } from "../logger.js";
import fs from "fs/promises";
import { selectNextMilestone, deriveMilestoneContext } from "../milestones/milestoneManager.js";
import { selectNextTask, deriveTaskContext, pickSuggestion } from "../tasks/taskManager.js";
import { firstString, slugify, normalizeRepoPath } from "../util.js";
import { waitForPersonaCompletion, sendPersonaRequest, parseEventResult, interpretPersonaStatus, extractJsonPayloadFromText } from "../agents/persona.js";
import { normalizeTaskStatus } from "../tasks/taskManager.js";

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
  
    type PersonaStageResponse = {
      event: any;
      result: any;
      status: any;
    };
  
    type StageOutcome = {
      pass: boolean;
      details: string;
      payload?: any;
      rawOutput: string;
    };
  
    type LeadCycleOutcome = {
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
  
    async function runPersonaWithStatus(toPersona: string, step: string, intent: string, payload: any, options?: { timeoutMs?: number }): Promise<PersonaStageResponse> {
      const corrId = await sendPersonaRequest(r, {
        workflowId,
        toPersona,
        step,
        intent,
        payload,
        repo: repoRemote,
        branch: branchName,
        projectId: projectId!,
        deadlineSeconds: options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined
      });
      const event = await waitForPersonaCompletion(r, toPersona, workflowId, corrId, options?.timeoutMs);
      const resultObj = parseEventResult(event.fields.result);
      const statusInfo = interpretPersonaStatus(resultObj?.output);
      return { event, result: resultObj, status: statusInfo };
    }
  
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
  
    async function runEngineerPlanApproval(implementationPersona: string, plannerPersona: string, basePayload: Record<string, any>, attempt: number, feedback: string | null): Promise<PlanApprovalOutcome | null> {
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
          logger.debug("plan persona result raw", { planner, workflowId, planCorrId, planResultObjPreview: String(planResultObj?.output || '').slice(0,200) });
        const planOutput = planResultObj?.output || "";
        const planJson = extractJsonPayloadFromText(planOutput) || planResultObj?.payload || null;
          logger.debug("plan persona parsed json", { planner, workflowId, planCorrId, hasPlanJson: !!planJson, planJsonPreview: planJson ? JSON.stringify(planJson).slice(0,400) : null });
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
          logger.debug("plan approved payload preview", { workflowId, planner, planAttempt: planAttempt + 1, planStepsPreview: JSON.stringify(planSteps).slice(0,400) });
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
  
    type StageTaskDefinition = {
      id: string;
      title: string;
      description: string;
      defaultPriority?: number;
      assigneePersona?: string;
      schedule?: string;
      diagnostics?: QaDiagnostics | string | null;
    };
  
    function diagnosticsToMarkdown(diagnostics: any): string {
      if (!diagnostics) return "";
      if (typeof diagnostics === "string") return diagnostics;
      if (Array.isArray(diagnostics)) {
        return diagnostics.map((entry: any) => {
          if (!entry || typeof entry !== "object") return "";
          const command = typeof entry.command === "string" ? entry.command : "(unknown command)";
          const exitCode = typeof entry.exitCode === "number" ? entry.exitCode : "unknown";
          const stderr = typeof entry.stderr === "string" ? entry.stderr : "";
          const stdout = typeof entry.stdout === "string" ? entry.stdout : "";
          const parts = [`Command: ${command}`, `Exit code: ${exitCode}`];
          if (stdout.trim().length) parts.push(`STDOUT:\n${stdout.trim()}`);
          if (stderr.trim().length) parts.push(`STDERR:\n${stderr.trim()}`);
          return parts.join("\n");
        }).filter(Boolean).join("\n\n");
      }
      if (typeof diagnostics === "object") {
        const entries = Array.isArray((diagnostics as any).entries) ? (diagnostics as any).entries : [diagnostics];
        return diagnosticsToMarkdown(entries);
      }
      return String(diagnostics);
    }
  
    function extractStageTasks(stage: "qa" | "devops" | "code-review" | "security", details: string, payload: any): StageTaskDefinition[] {
      const tasks: StageTaskDefinition[] = [];
      const baseDescription = details || "Follow-up required";
      const diagnostics = diagnosticsToMarkdown(payload?.diagnostics ?? payload?.logs ?? payload?.evidence);
  
      const pushTask = (title: string, description: string, priority = 5, assignee?: string) => {
        const merged = diagnostics.trim().length ? `${description}\n\nDiagnostics:\n${diagnostics}` : description;
        tasks.push({
          id: `${stage}-${tasks.length + 1}`,
          title,
          description: merged,
          defaultPriority: priority,
          assigneePersona: assignee
        });
      };
  
      const issues = Array.isArray(payload?.issues) ? payload.issues : [];
      if (issues.length) {
        for (const [idx, issue] of issues.entries()) {
          if (!issue || typeof issue !== "object") continue;
          const title = typeof issue.title === "string" && issue.title.trim().length
            ? issue.title.trim()
            : `${stage.toUpperCase()} follow-up ${idx + 1}`;
          const note = typeof issue.note === "string" && issue.note.trim().length ? issue.note.trim() : baseDescription;
          const fileInfo = typeof issue.file === "string" && issue.file.trim().length ? `File: ${issue.file.trim()}` : "";
          const descriptionParts = [note];
          if (fileInfo) descriptionParts.push(fileInfo);
          if (issue.remediation) descriptionParts.push(String(issue.remediation));
          pushTask(title, descriptionParts.join("\n"), issue.priority_score ?? 5, issue.assignee_persona);
        }
      } else if (typeof payload === "object" && Array.isArray(payload?.actions)) {
        for (const [idx, action] of payload.actions.entries()) {
          if (!action || typeof action !== "object") continue;
          const title = typeof action.title === "string" && action.title.trim().length
            ? action.title.trim()
            : `${stage.toUpperCase()} action ${idx + 1}`;
          const description = typeof action.description === "string" && action.description.trim().length
            ? action.description.trim()
            : baseDescription;
          pushTask(title, description, action.priority_score ?? 5, action.assignee_persona);
        }
      } else {
        const titleMap: Record<typeof stage, string> = {
          qa: "QA follow-up",
          devops: "DevOps follow-up",
          "code-review": "Code review follow-up",
          security: "Security follow-up"
        };
        pushTask(titleMap[stage], baseDescription, 5, stage === "devops" ? "devops" : "lead-engineer");
      }
  
      return tasks;
    }
  
    type CreatedTaskInfo = { summary: string; title: string; externalId?: string; createdId?: string };
  
    async function createDashboardTaskEntries(tasks: StageTaskDefinition[], options: {
      stage: "qa" | "devops" | "code-review" | "security";
      milestoneDescriptor: any;
      parentTaskDescriptor: any;
      projectId: string | null;
      projectName: string | null;
      scheduleHint?: string;
    }): Promise<CreatedTaskInfo[]> {
      if (!tasks.length) return [];
      const rawMilestone = options.milestoneDescriptor?.id ?? options.milestoneDescriptor?.slug ?? null;
      let milestoneId: string | null = null;
      let milestoneSlug: string | null = null;
      if (typeof rawMilestone === "string") {
        const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        if (uuidRegex.test(rawMilestone)) milestoneId = rawMilestone;
        else milestoneSlug = String(rawMilestone);
      }
      const parentTaskId = options.parentTaskDescriptor?.id || null;
    const summaries: CreatedTaskInfo[] = [];
  
      for (const task of tasks) {
        const title = task.title || `${options.stage.toUpperCase()} follow-up`;
        const schedule = (task.schedule || options.scheduleHint || "").toLowerCase();
        let scheduleNote = "";
        let targetParentTaskId = undefined as string | undefined;
        if (schedule === "urgent") {
          targetParentTaskId = parentTaskId || undefined;
          scheduleNote = "Scheduled as urgent child task for current work item.";
        } else if (schedule === "high") {
          scheduleNote = "Complete within the current milestone.";
        } else if (schedule === "medium") {
          scheduleNote = "Plan for an upcoming milestone.";
        } else if (schedule === "low") {
          scheduleNote = "Track under Future Enhancements.";
        }
        const descriptionBase = task.description || `Follow-up required for ${options.stage}`;
        const description = scheduleNote ? `${descriptionBase}\n\nSchedule: ${scheduleNote}` : descriptionBase;
        // If we have a milestone slug but not an ID, attempt to resolve it via the dashboard project status
        let resolvedMilestoneId = milestoneId;
        let resolvedMilestoneSlug = milestoneSlug;
        if (!resolvedMilestoneId && resolvedMilestoneSlug && options.projectId) {
          try {
            const proj = await fetchProjectStatus(options.projectId);
            const p = proj as any;
            const candidates = p?.milestones || p?.milestones_list || (p?.milestones?.items) || [];
            if (Array.isArray(candidates)) {
              const match = candidates.find((m: any) => {
                if (!m) return false;
                const s = (m.slug || m.name || m.title || "").toString().toLowerCase();
                return s === String(resolvedMilestoneSlug).toLowerCase();
              });
              if (match && match.id) {
                resolvedMilestoneId = match.id;
                resolvedMilestoneSlug = null;
              }
            }
          } catch (err) {
            // ignore resolution errors
          }
        }
  
        // derive project_slug if available (use provided projectName or fallback to known project slug)
        const derivedProjectSlug = options.projectName || undefined; // prefer projectName for slug
        const externalId = `auto-${options.stage}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  
        // if QA diagnostics exist on the task, prepare attachments (base64) clipped to configured max size
        let attachments: { name: string; content_base64: string }[] | undefined = undefined;
        try {
    const diag: any = (task.diagnostics || null);
          if (diag && typeof diag === "object") {
            const text = typeof diag.text === "string" ? diag.text : (typeof diag === "string" ? diag : JSON.stringify(diag));
            if (text && text.length) {
              const maxBytes = cfg.dashboardMaxAttachmentBytes || 200000;
              // clip to maxBytes when UTF-8 encoded conservatively: assume 1 char = 1 byte for ASCII; further clipping is acceptable
              let clipped = text;
              if (Buffer.byteLength(clipped, "utf8") > maxBytes) {
                clipped = clipped.slice(0, Math.floor(maxBytes * 0.9));
              }
              const b64 = Buffer.from(clipped, "utf8").toString("base64");
              attachments = [{ name: `qa-diagnostics-${Date.now()}.txt`, content_base64: b64 }];
            }
          }
        } catch (err) {
          // ignore attachment build errors
          attachments = undefined;
        }
  
        // If creating QA follow-ups, request initial_status=in_progress so they're visible immediately
        const createOptions: Record<string, any> = { create_milestone_if_missing: cfg.dashboardCreateMilestoneIfMissing };
        if (options.stage === 'qa') createOptions.initial_status = 'in_progress';
  
        const body = await createDashboardTask({
          projectId: options.projectId || undefined,
          projectSlug: derivedProjectSlug || undefined,
          milestoneId: resolvedMilestoneId || undefined,
          milestoneSlug: resolvedMilestoneSlug || undefined,
          parentTaskId: targetParentTaskId,
          title,
          description,
          effortEstimate: 3,
          priorityScore: task.defaultPriority ?? 5,
          assigneePersona: task.assigneePersona,
          externalId,
          attachments,
          options: createOptions
        });
  
        if (body?.ok) {
          // store external -> task id mapping if server returned an id
          try {
            const createdId = body?.body && (body.body.id || body.body.task_id || (body.body.task && body.body.task.id));
            if (createdId && externalId) externalToTaskId.set(String(externalId), String(createdId));
            const summaryParts = [title];
            if (schedule) summaryParts.push(`schedule: ${schedule}`);
            summaryParts.push(`priority ${task.defaultPriority ?? 5}`);
            summaries.push({ summary: summaryParts.join(" | "), title, externalId, createdId: String(createdId) });
            continue;
          } catch {}
          const summaryParts = [title];
          if (schedule) summaryParts.push(`schedule: ${schedule}`);
          summaryParts.push(`priority ${task.defaultPriority ?? 5}`);
          summaries.push({ summary: summaryParts.join(" | "), title, externalId });
        } else {
          logger.warn("dashboard task creation failed", {
            stage: options.stage,
            title,
            milestoneId,
            parentTaskId,
            projectId: options.projectId,
            error: body?.error || body?.body || "unknown"
          });
        }
      }
  
      return summaries;
    }
  
    async function routeTasksThroughProjectManager(tasks: StageTaskDefinition[], stage: "code-review" | "security"): Promise<StageTaskDefinition[]> {
      if (!tasks.length) return tasks;
  
      const payload = {
        stage,
        tasks: tasks.map(task => ({
          id: task.id,
          title: task.title,
          description: task.description,
          default_priority: task.defaultPriority ?? 5
        }))
      };
  
      try {
        const response = await runPersonaWithStatus(
          "project-manager",
          "pm-task-routing",
          "schedule_followup_tasks",
          payload
        );
  
        const pmPayload = response.status.payload || extractJsonPayloadFromText(response.result?.output) || null;
        if (!pmPayload || typeof pmPayload !== "object" || !Array.isArray(pmPayload.tasks)) return tasks;
  
        const scheduleMap = new Map<string, any>();
        for (const entry of pmPayload.tasks) {
          if (!entry || typeof entry !== "object") continue;
          const id = typeof entry.id === "string" ? entry.id : null;
          if (!id) continue;
          scheduleMap.set(id, entry);
        }
  
        return tasks.map(task => {
          const mapped = scheduleMap.get(task.id);
          if (!mapped) return task;
          const schedule = typeof mapped.schedule === "string" ? mapped.schedule.toLowerCase() : undefined;
          const assignee = typeof mapped.assignee === "string" ? mapped.assignee : task.assigneePersona;
          const priority = typeof mapped.priority_score === "number" ? mapped.priority_score : task.defaultPriority;
          return { ...task, schedule, assigneePersona: assignee, defaultPriority: priority };
        });
      } catch (error) {
        logger.warn("project-manager scheduling failed", { stage, error });
        return tasks;
      }
    }
  
    async function runLeadCycle(feedbackNotes: string[], attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<LeadCycleOutcome> {
      const feedback = feedbackNotes.filter(Boolean).join("\n\n");
      const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
        const engineerBasePayload = {
        repo: repoRemote,
        branch: branchName,
        project_id: projectId,
        project_slug: projectSlug || undefined,
        project_name: payloadObj.project_name || projectInfo?.name || "",
        milestone: currentMilestoneDescriptorValue,
        milestone_name: milestoneNameForPayload,
        milestone_slug: currentMilestoneDescriptorValue?.slug || milestoneSlug,
        task: currentTaskDescriptorValue,
        task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
        // If there is coordinator feedback (e.g., QA failure details), use that as the immediate goal so the implementation planner focuses on fixing it
        goal: feedback || projectInfo?.goal || projectInfo?.direction || currentMilestoneDescriptorValue?.goal,
        base_branch: baseBranch,
        feedback: feedback || undefined,
        revision: attempt
      };
  
      const plannerPersona = IMPLEMENTATION_PLANNER_MAP.get("lead-engineer") || "lead-engineer";
      const planOutcome = await runEngineerPlanApproval("lead-engineer", plannerPersona, engineerBasePayload, attempt, feedback || null);
  
      const leadCorrId = randomUUID();
      logger.info("coordinator dispatch lead", {
        workflowId,
        attempt,
        taskName: currentTaskNameValue,
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
  
      // Attempt to mark a corresponding dashboard task as in_progress (best-effort).
      // Prefer updating by external_id mapping when available, otherwise fall back to title search.
      try {
        let didUpdate = false;
        const candidateExternalId = currentTaskDescriptorValue?.id || null;
        if (candidateExternalId && externalToTaskId.has(String(candidateExternalId))) {
          const mapped = externalToTaskId.get(String(candidateExternalId));
          if (mapped) {
            await updateTaskStatus(mapped, "in_progress").catch(() => {});
            didUpdate = true;
          }
        }
  
        if (!didUpdate && projectId && currentTaskNameValue) {
          const proj = await fetchProjectStatus(projectId) as any;
          const candidates = Array.isArray(proj?.tasks) ? proj.tasks : (Array.isArray(proj?.task_list) ? proj.task_list : (Array.isArray(proj?.tasks_list) ? proj.tasks_list : []));
          if (Array.isArray(candidates) && candidates.length) {
            const match = candidates.find((t: any) => (t.title || t.name || t.summary || "").toString().toLowerCase() === (currentTaskNameValue || "").toLowerCase());
            if (match && match.id) {
              await updateTaskStatus(match.id, "in_progress").catch(() => {});
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
  
    async function runQaStage(leadOutcome: LeadCycleOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
      const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
      const qaResponse = await runPersonaWithStatus(
        "tester-qa",
        "4-qa-verification",
        "verify_build_and_tests",
        {
          repo: repoRemote,
          branch: branchName,
          project_id: projectId,
          project_slug: projectSlug || undefined,
          project_name: payloadObj.project_name || projectInfo?.name || "",
          milestone: currentMilestoneDescriptorValue,
          milestone_name: milestoneNameForPayload,
          task: currentTaskDescriptorValue,
          task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
          commit: leadOutcome.commit,
          changed_files: leadOutcome.paths,
          lead_output: leadOutcome.output,
          revision: attempt
        }
      );
      const qaStatus = qaResponse.status;
      let qaDetails = qaStatus.details;
      let qaPayload = qa.payload;
  
      if (!qaDetails && qaResponse.result?.output) qaDetails = qaResponse.result.output;
  
      if (qaStatus.status === "fail") {
        const payloadObj = (qaPayload && typeof qaPayload === "object") ? { ...qaPayload } : {};
        let commands: string[] = [];
        if (Array.isArray((payloadObj as any).commands)) {
          const commandValues = (payloadObj as any).commands as unknown as any[];
          commands = commandValues
            .map((cmd: any) => (typeof cmd === "string" ? cmd.trim() : ""))
            .filter((value: string): value is string => value.length > 0);
        }
        if (!commands.length && typeof qaDetails === "string") {
          const lowerDetails = qaDetails.toLowerCase();
          if (lowerDetails.includes("lint")) commands.push("npm run lint");
          if (lowerDetails.includes("test")) commands.push("npm test");
        }
  
        commands = Array.from(new Set(commands));
  
        if (commands.length) {
          try {
            const diagnostics = await gatherQaDiagnostics(commands, repoRoot);
            if (diagnostics) {
              const diagnosticsSection = `Diagnostics:\n${diagnostics.text}`;
              qaDetails = qaDetails ? `${qaDetails}\n\n${diagnosticsSection}` : diagnosticsSection;
              payloadObj.diagnostics = diagnostics.entries;
              if (!payloadObj.commands) payloadObj.commands = commands;
              qaPayload = payloadObj;
              logger.info("qa diagnostics executed", {
                workflowId,
                commands: diagnostics.entries.map(entry => ({
                  command: entry.command,
                  exitCode: entry.exitCode,
                  durationMs: entry.durationMs
                }))
              });
            }
          } catch (error: any) {
            logger.warn("qa diagnostics execution failed", { workflowId, error });
          }
        }
  
        let qaTasks = extractStageTasks("qa", qaDetails, qaPayload).map(task => ({
          ...task,
          schedule: task.schedule || "urgent",
          assigneePersona: task.assigneePersona || "lead-engineer"
        }));
  
        // If QA failed because there is no test or lint script in package.json, create an implementation-planner follow-up
        try {
          const hasPackageJson = await (async () => {
            try {
              const fs = await import("fs/promises");
              const pathMod = await import("path");
              // Fallback to process.cwd() when repo root isn't available in this context
              const pkgPath = pathMod.resolve(process.cwd(), "package.json");
              const content = await fs.readFile(pkgPath, "utf8").catch(() => "");
              if (!content) return { exists: false, hasTest: false, hasLint: false };
              const parsed = JSON.parse(content || "{}");
              return { exists: true, hasTest: !!(parsed.scripts && parsed.scripts.test), hasLint: !!(parsed.scripts && (parsed.scripts.lint || parsed.scripts['eslint'])) };
            } catch {
              return { exists: false, hasTest: false, hasLint: false };
            }
          })();
  
          if (hasPackageJson.exists && (!hasPackageJson.hasTest || !hasPackageJson.hasLint)) {
            const missingParts: string[] = [];
            if (!hasPackageJson.hasTest) missingParts.push("test script");
            if (!hasPackageJson.hasLint) missingParts.push("lint script");
            const title = `Add missing ${missingParts.join(' and ')}`;
            const description = `QA found that package.json is missing the following scripts: ${missingParts.join(', ')}. Add scripts and basic tests/lint configuration so QA can validate changes.\n\nQA details:\n${qaDetails}`;
            // Route to implementation-planner first so a plan is made
            await sendPersonaRequest(r, {
              workflowId,
              toPersona: "implementation-planner",
              step: "followup-create-plan",
              intent: "plan_execution",
              payload: { goal: title, details: description, suggested_files: ["package.json"], priority: "high" },
              repo: repoRemote,
              branch: branchName,
              projectId: projectId || undefined
            });
          }
        } catch (err) {
          logger.debug("qa followup package.json check failed", { workflowId, error: err });
        }
  
        // Let project-manager decide priority and routing before task creation
        try {
          const routed = await runPersonaWithStatus(
            "project-manager",
            "pm-task-routing",
            "schedule_followup_tasks",
            {
              stage: "qa",
              tasks: qaTasks.map(task => ({ id: task.id, title: task.title, description: task.description, default_priority: task.defaultPriority ?? 5 }))
            }
          );
          const pmPayload = routed.status.payload || extractJsonPayloadFromText(routed.result?.output) || null;
          if (pmPayload && typeof pmPayload === "object" && Array.isArray(pmPayload.tasks)) {
            // apply scheduling/assignee/priority back to qaTasks
            const scheduleMap = new Map<string, any>();
            for (const entry of pmPayload.tasks) { if (entry && typeof entry === 'object' && entry.id) scheduleMap.set(entry.id, entry); }
            qaTasks = qaTasks.map(task => {
              const mapped = scheduleMap.get(task.id);
              if (!mapped) return task;
              return { ...task, schedule: typeof mapped.schedule === 'string' ? mapped.schedule : task.schedule, assigneePersona: typeof mapped.assignee === 'string' ? mapped.assignee : task.assigneePersona, defaultPriority: typeof mapped.priority_score === 'number' ? mapped.priority_score : task.defaultPriority };
            });
          }
        } catch (err) {
          logger.warn("project-manager routing failed for QA tasks, continuing with defaults", { workflowId, error: err });
        }
  
        const createdTaskInfos = await createDashboardTaskEntries(qaTasks, {
          stage: "qa",
          milestoneDescriptor: currentMilestoneDescriptorValue,
          parentTaskDescriptor: currentTaskDescriptorValue,
          projectId,
          projectName: projectInfo?.name || null
        });
        if (createdTaskInfos.length) {
          // Best-effort: mark original task as on_hold and ensure QA-created tasks are in_progress
          try {
            const originalExternal = currentTaskDescriptorValue?.id || null;
            let originalId: string | null = null;
            if (originalExternal && externalToTaskId.has(String(originalExternal))) originalId = externalToTaskId.get(String(originalExternal)) || null;
            if (!originalId && projectId && currentTaskNameValue) {
              const proj = await fetchProjectStatus(projectId) as any;
              const candidates = Array.isArray(proj?.tasks) ? proj.tasks : (Array.isArray(proj?.task_list) ? proj.task_list : (Array.isArray(proj?.tasks_list) ? proj.tasks_list : []));
              if (Array.isArray(candidates) && candidates.length) {
                const match = candidates.find((t: any) => (t.title || t.name || t.summary || "").toString().toLowerCase() === (currentTaskNameValue || "").toLowerCase());
                if (match && match.id) originalId = match.id;
              }
            }
            if (originalId) await updateTaskStatus(originalId, 'on_hold').catch(() => {});
          } catch (err) {
            logger.debug('failed to set original task on_hold', { workflowId, error: err });
          }
  
          // Ensure created QA tasks are in_progress (they should already be created with that status when possible)
          try {
            for (const info of createdTaskInfos) {
              if (info.createdId) {
                await updateTaskStatus(info.createdId, 'in_progress').catch(() => {});
              }
            }
          } catch (err) {
            logger.debug('failed to set created QA tasks in_progress', { workflowId, error: err });
          }
  
          const summary = createdTaskInfos.map(item => `- ${item.summary}`).join("\n");
          qaDetails = `${qaDetails}\n\nDashboard Tasks Created:\n${summary}`;
        }
      }
  
      return {
        pass: qaStatus.status === "pass",
        details: qaDetails,
        payload: qaPayload,
        rawOutput: qaResponse.result?.output || ""
      };
    }
  
    async function runCodeReviewStage(leadOutcome: LeadCycleOutcome, qaOutcome: StageOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
      const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
      const reviewResponse = await runPersonaWithStatus(
        "code-reviewer",
        "5-code-review",
        "review_changes",
        {
          repo: repoRemote,
          branch: branchName,
          project_id: projectId,
          project_slug: projectSlug || undefined,
          project_name: payloadObj.project_name || projectInfo?.name || "",
          milestone: currentMilestoneDescriptorValue,
          milestone_name: milestoneNameForPayload,
          task: currentTaskDescriptorValue,
          task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
          commit: leadOutcome.commit,
          qa_report: qaOutcome.details,
          qa_payload: qaOutcome.payload,
          lead_output: leadOutcome.output,
          revision: attempt
        }
      );
      let reviewDetails = reviewResponse.status.details;
      let reviewPayload = reviewResponse.status.payload;
  
      if (reviewResponse.status.status !== "pass") {
        let tasks = extractStageTasks("code-review", reviewDetails, reviewPayload);
        tasks = await routeTasksThroughProjectManager(tasks, "code-review");
        const createdInfos = await createDashboardTaskEntries(tasks, {
          stage: "code-review",
          milestoneDescriptor: currentMilestoneDescriptorValue,
          parentTaskDescriptor: currentTaskDescriptorValue,
          projectId,
          projectName: projectInfo?.name || null,
          scheduleHint: "urgent"
        });
        if (createdInfos.length) {
          const summary = createdInfos.map(item => `- ${item.summary}`).join("\n");
          reviewDetails = `${reviewDetails}\n\nDashboard Tasks Created:\n${summary}`;
        }
      }
  
      return {
        pass: reviewResponse.status.status === "pass",
        details: reviewDetails,
        payload: reviewPayload,
        rawOutput: reviewResponse.result?.output || ""
      };
    }
  
    async function runSecurityReviewStage(leadOutcome: LeadCycleOutcome, qaOutcome: StageOutcome, codeOutcome: StageOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
      const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
      const securityResponse = await runPersonaWithStatus(
        "security-review",
        "6-security-review",
        "assess_security",
        {
          repo: repoRemote,
          branch: branchName,
          project_id: projectId,
          project_slug: projectSlug || undefined,
          project_name: payloadObj.project_name || projectInfo?.name || "",
          milestone: currentMilestoneDescriptorValue,
          milestone_name: milestoneNameForPayload,
          task: currentTaskDescriptorValue,
          task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
          commit: leadOutcome.commit,
          qa_report: qaOutcome.details,
          code_review_report: codeOutcome.details,
          revision: attempt
        }
      );
      let securityDetails = securityResponse.status.details;
      let securityPayload = securityResponse.status.payload;
  
      if (securityResponse.status.status !== "pass") {
        let tasks = extractStageTasks("security", securityDetails, securityPayload);
        tasks = await routeTasksThroughProjectManager(tasks, "security");
        const createdInfos = await createDashboardTaskEntries(tasks, {
          stage: "security",
          milestoneDescriptor: currentMilestoneDescriptorValue,
          parentTaskDescriptor: currentTaskDescriptorValue,
          projectId,
          projectName: projectInfo?.name || null,
          scheduleHint: "urgent"
        });
        if (createdInfos.length) {
          const summary = createdInfos.map(item => `- ${item.summary}`).join("\n");
          securityDetails = `${securityDetails}\n\nDashboard Tasks Created:\n${summary}`;
        }
      }
  
      return {
        pass: securityResponse.status.status === "pass",
        details: securityDetails,
        payload: securityPayload,
        rawOutput: securityResponse.result?.output || ""
      };
    }
  
    async function runDevOpsStage(leadOutcome: LeadCycleOutcome, qaOutcome: StageOutcome, codeOutcome: StageOutcome, securityOutcome: StageOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
      const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
      const devopsResponse = await runPersonaWithStatus(
        "devops",
        "7-devops-ci",
        "run_ci_pipeline",
        {
          repo: repoRemote,
          branch: branchName,
          project_id: projectId,
          project_slug: projectSlug || undefined,
          project_name: payloadObj.project_name || projectInfo?.name || "",
          milestone: currentMilestoneDescriptorValue,
          milestone_name: milestoneNameForPayload,
          task: currentTaskDescriptorValue,
          task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
          commit: leadOutcome.commit,
          qa_report: qaOutcome.details,
          code_review_report: codeOutcome.details,
          security_report: securityOutcome.details,
          revision: attempt
        }
      );
      let devopsDetails = devopsResponse.status.details;
      let devopsPayload = devopsResponse.status.payload;
  
      if (devopsResponse.status.status === "fail") {
        const tasks = extractStageTasks("devops", devopsDetails, devopsPayload).map(task => ({
          ...task,
          schedule: task.schedule || "urgent",
          assigneePersona: task.assigneePersona || "devops"
        }));
        const createdInfos = await createDashboardTaskEntries(tasks, {
          stage: "devops",
          milestoneDescriptor: currentMilestoneDescriptorValue,
          parentTaskDescriptor: currentTaskDescriptorValue,
          projectId,
          projectName: projectInfo?.name || null
        });
        if (createdInfos.length) {
          const summary = createdInfos.map(item => `- ${item.summary}`).join("\n");
          devopsDetails = `${devopsDetails}\n\nDashboard Tasks Created:\n${summary}`;
        }
      }
  
      return {
        pass: devopsResponse.status.status === "pass",
        details: devopsDetails,
        payload: devopsPayload,
        rawOutput: devopsResponse.result?.output || ""
      };
    }
  
    async function runProjectManagerStage(leadOutcome: LeadCycleOutcome, qaOutcome: StageOutcome, codeOutcome: StageOutcome, securityOutcome: StageOutcome, devopsOutcome: StageOutcome, attempt: number, currentMilestoneDescriptorValue: any, currentTaskDescriptorValue: any, currentTaskNameValue: string | null): Promise<StageOutcome> {
      const milestoneNameForPayload = currentMilestoneDescriptorValue?.name || milestoneName;
      const pmResponse = await runPersonaWithStatus(
        "project-manager",
        "8-project-update",
        "update_project_dashboard",
        {
          repo: repoRemote,
          branch: branchName,
          project_id: projectId,
          project_slug: projectSlug || undefined,
          project_name: payloadObj.project_name || projectInfo?.name || "",
          milestone: currentMilestoneDescriptorValue,
          milestone_name: milestoneNameForPayload,
          task: currentTaskDescriptorValue,
          task_name: currentTaskNameValue || (currentTaskDescriptorValue?.name ?? ""),
          commit: leadOutcome.commit,
          qa_report: qaOutcome.details,
          code_review_report: codeOutcome.details,
          security_report: securityOutcome.details,
          devops_report: devopsOutcome.details,
          revision: attempt
        }
      );
      const pass = pmResponse.status.status !== "fail";
      if (!pass) {
        throw new Error(`Project manager reported failure: ${pmResponse.status.details}`);
      }
      return {
        pass: true,
        details: pmResponse.status.details,
        payload: pmResponse.status.payload,
        rawOutput: pmResponse.result?.output || ""
      };
    }
  
    async function executeTaskLifecycle(currentTaskNameValue: string | null, currentTaskDescriptorValue: any, currentMilestoneDescriptorValue: any): Promise<string> {
      let feedbackNotes: string[] = [];
      let attempt = 0;
      while (attempt < MAX_REVISION_ATTEMPTS) {
        attempt += 1;
        const leadOutcome = await runLeadCycle(feedbackNotes, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
        if (!leadOutcome.success) {
          const notes: string[] = [`Lead engineer attempt ${attempt} failed: ${leadOutcome.details}`];
          if (leadOutcome.plan?.history?.length) {
            const historyText = leadOutcome.plan.history.map(entry => `Attempt ${entry.attempt} plan:\n${entry.content.trim()}`).join("\n\n");
            notes.push(`Plan history:\n${historyText}`);
          }
          feedbackNotes = notes;
          continue;
        }
        feedbackNotes = [];
  
        const qaOutcome = await runQaStage(leadOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
        if (!qaOutcome.pass) {
          feedbackNotes = [`QA feedback: ${qaOutcome.details}`];
          continue;
        }
  
        const codeOutcome = await runCodeReviewStage(leadOutcome, qaOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
        if (!codeOutcome.pass) {
          feedbackNotes = [`Code review feedback: ${codeOutcome.details}`];
          continue;
        }
  
        const securityOutcome = await runSecurityReviewStage(leadOutcome, qaOutcome, codeOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
        if (!securityOutcome.pass) {
          feedbackNotes = [`Security review feedback: ${securityOutcome.details}`];
          continue;
        }
  
        const devopsOutcome = await runDevOpsStage(leadOutcome, qaOutcome, codeOutcome, securityOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
        if (!devopsOutcome.pass) {
          feedbackNotes = [`DevOps feedback: ${devopsOutcome.details}`];
          continue;
        }
  
        await runProjectManagerStage(leadOutcome, qaOutcome, codeOutcome, securityOutcome, devopsOutcome, attempt, currentMilestoneDescriptorValue, currentTaskDescriptorValue, currentTaskNameValue);
  
        const commitSummary = leadOutcome.commit?.message
          ? `Commit: ${leadOutcome.commit.message}`
          : (leadOutcome.noChanges ? "No new commits were necessary." : "Commit information unavailable.");
        const summaryParts = [
          currentTaskNameValue ? `Task ${currentTaskNameValue} completed.` : "Task cycle completed.",
          commitSummary,
          `QA: ${qaOutcome.details || qaOutcome.rawOutput || 'n/a'}`,
          `Code Review: ${codeOutcome.details || codeOutcome.rawOutput || 'n/a'}`,
          `Security: ${securityOutcome.details || securityOutcome.rawOutput || 'n/a'}`,
          `DevOps: ${devopsOutcome.details || devopsOutcome.rawOutput || 'n/a'}`
        ];
        return summaryParts.join(' ');
      }
  
      throw new Error(`Exceeded ${MAX_REVISION_ATTEMPTS} revision attempts for task ${currentTaskNameValue || '(unnamed)'}`);
    }
  
    const completedTaskSummaries: string[] = [];
    // map external_id -> dashboard task id for precise updates (in-memory)
    const externalToTaskId = new Map<string,string>();
    let currentTaskObject = selectedTask;
    let currentTaskDescriptorValue = taskDescriptor;
    let currentTaskNameValue = taskName;
    if (!currentTaskObject && nextActionData?.suggestions?.length) {
      const suggested = pickSuggestion(nextActionData.suggestions);
      if (suggested) {
        currentTaskObject = suggested;
        const taskCtx = deriveTaskContext(currentTaskObject);
        currentTaskDescriptorValue = taskCtx.descriptor;
        currentTaskNameValue = taskCtx.name;
        payloadObj.task = currentTaskDescriptorValue;
        payloadObj.task_name = currentTaskNameValue || "";
      }
    }
    let currentMilestoneObject = selectedMilestone;
    let currentMilestoneDescriptorValue = milestoneDescriptor;
    let currentMilestoneNameValue = milestoneName;
    let currentMilestoneSlugValue = milestoneSlug;
    let iterationCount = 0;
  
    if (currentTaskDescriptorValue) payloadObj.task = currentTaskDescriptorValue;
    if (currentTaskNameValue) payloadObj.task_name = currentTaskNameValue;
    if (currentMilestoneDescriptorValue) payloadObj.milestone = currentMilestoneDescriptorValue;
    payloadObj.milestone_name = currentMilestoneNameValue;
  
    while ((currentTaskDescriptorValue || iterationCount === 0) && iterationCount < 20) {
      iterationCount += 1;
      logger.info("coordinator task cycle begin", {
        workflowId,
        iteration: iterationCount,
        taskName: currentTaskNameValue,
        milestoneName: currentMilestoneNameValue
      });
      const summary = await executeTaskLifecycle(currentTaskNameValue, currentTaskDescriptorValue, currentMilestoneDescriptorValue);
      completedTaskSummaries.push(summary);
      logger.info("coordinator task cycle complete", {
        workflowId,
        iteration: iterationCount,
        summary
      });
  
      projectInfo = await fetchProjectStatus(projectId);
      projectStatus = await fetchProjectStatusDetails(projectId);
      nextActionData = await fetchProjectNextAction(projectId);
  
      const milestoneSourceNext = projectStatus ?? projectInfo;
      let nextSelectedMilestone = (payloadObj.milestone && typeof payloadObj.milestone === "object") ? payloadObj.milestone : selectNextMilestone(milestoneSourceNext);
      if (!nextSelectedMilestone && projectInfo && projectInfo !== milestoneSourceNext) {
        nextSelectedMilestone = selectNextMilestone(projectInfo) || nextSelectedMilestone;
      }
      if (!nextSelectedMilestone && milestoneSourceNext && typeof milestoneSourceNext === "object") {
        const explicit = (milestoneSourceNext as any).next_milestone ?? (milestoneSourceNext as any).nextMilestone;
        if (explicit && typeof explicit === "object") nextSelectedMilestone = explicit;
      }
      if (nextSelectedMilestone) {
        currentMilestoneObject = nextSelectedMilestone;
        const milestoneCtx = deriveMilestoneContext(currentMilestoneObject, currentMilestoneNameValue, branchName, currentTaskDescriptorValue);
        currentMilestoneDescriptorValue = milestoneCtx.descriptor;
        currentMilestoneNameValue = milestoneCtx.name;
        currentMilestoneSlugValue = milestoneCtx.slug || currentMilestoneSlugValue;
        if (milestoneCtx.branch) branchName = milestoneCtx.branch;
        payloadObj.milestone = currentMilestoneDescriptorValue;
        payloadObj.milestone_name = currentMilestoneNameValue;
      }
  
      let nextTask = selectNextTask(currentMilestoneObject, milestoneSourceNext, projectStatus, projectInfo, payloadObj);
      if (!nextTask && nextActionData?.suggestions?.length) {
        const suggested = pickSuggestion(nextActionData.suggestions);
        if (suggested) {
          nextTask = suggested;
          logger.info("coordinator selected suggestion task", { workflowId, task: suggested.name, reason: suggested.summary });
        }
      }
      if (!nextTask) break;
  
      currentTaskObject = nextTask;
      const taskCtx = deriveTaskContext(currentTaskObject);
      currentTaskDescriptorValue = taskCtx.descriptor;
      currentTaskNameValue = taskCtx.name;
      if (currentTaskDescriptorValue) payloadObj.task = currentTaskDescriptorValue;
      payloadObj.task_name = currentTaskNameValue || "";
      if (currentMilestoneDescriptorValue && currentMilestoneDescriptorValue.task !== currentTaskDescriptorValue) {
        currentMilestoneDescriptorValue.task = currentTaskDescriptorValue;
        payloadObj.milestone = currentMilestoneDescriptorValue;
      }
    }
  
    if (iterationCount >= 20) {
      throw new Error(`Coordinator exceeded task iteration limit for project ${projectId}`);
    }
  
    const summaryLines = [
      `Workflow orchestrated for project ${projectId}.`,
      `Milestone: ${currentMilestoneNameValue} (branch ${branchName}).`
    ];
    if (completedTaskSummaries.length) {
      completedTaskSummaries.forEach((line, index) => summaryLines.push(`Cycle ${index + 1}: ${line}`));
    } else {
      summaryLines.push("No active tasks to process.");
    }
  
    return summaryLines.join("\n");
  }
