import { cfg } from "./config.js";
import type { MessageTransport } from "./transport/MessageTransport.js";
import { RequestSchema } from "./schema.js";
import { SYSTEM_PROMPTS } from "./personas.js";
import { PERSONAS } from "./personaNames.js";
import { callLMStudio } from "./lmstudio.js";
import { fetchContext, recordEvent, fetchProjectStatus, fetchProjectStatusDetails, fetchProjectStatusSummary, createDashboardTask, updateTaskStatus } from "./dashboard.js";
import { resolveRepoFromPayload, getRepoMetadata, commitAndPushPaths, checkoutBranchFromBase, ensureBranchPublished, runGit } from "./gitUtils.js";
import { logger } from "./logger.js";
import { publishEvent } from "./redis/eventPublisher.js";

/**
 * Helper to cleanup old log files, keeping only the most recent N files
 * @param logDir - Directory containing log files
 * @param pattern - Glob pattern to match log files (e.g., "task-*-plan.log")
 * @param keepCount - Number of most recent files to keep (default: 5)
 */
async function cleanupOldLogs(logDir: string, pattern: string, keepCount: number = 5): Promise<string[]> {
  const fs = await import("fs/promises");
  const pathMod = await import("path");
  
  try {
    // Check if directory exists
    try {
      await fs.access(logDir);
    } catch {
      return []; // Directory doesn't exist, nothing to clean up
    }

    // Read all files in directory
    const files = await fs.readdir(logDir);
    
    // Filter files matching pattern and get their stats
    const matchingFiles: { name: string; path: string; mtime: number }[] = [];
    for (const file of files) {
      // Simple pattern matching (task-*-plan.log or task-*-qa.log)
      const logType = pattern.includes("plan") ? "plan" : "qa";
      if (file.startsWith("task-") && file.endsWith(`-${logType}.log`)) {
        const filePath = pathMod.join(logDir, file);
        try {
          const stats = await fs.stat(filePath);
          matchingFiles.push({
            name: file,
            path: filePath,
            mtime: stats.mtimeMs
          });
        } catch (e) {
          logger.warn("Failed to stat log file", { file: filePath, error: e });
        }
      }
    }

    // Sort by modification time (newest first)
    matchingFiles.sort((a, b) => b.mtime - a.mtime);

    // Determine files to delete (keep only the most recent keepCount)
    const filesToDelete = matchingFiles.slice(keepCount);
    
    if (filesToDelete.length === 0) {
      return [];
    }

    // Delete old files
    const deletedPaths: string[] = [];
    for (const file of filesToDelete) {
      try {
        await fs.unlink(file.path);
        deletedPaths.push(file.path);
        logger.debug("Deleted old log file", { file: file.name, logDir });
      } catch (e) {
        logger.warn("Failed to delete old log file", { file: file.path, error: e });
      }
    }

    if (deletedPaths.length > 0) {
      logger.info("Cleaned up old log files", {
        logDir,
        pattern,
        deletedCount: deletedPaths.length,
        keptCount: matchingFiles.length - deletedPaths.length
      });
    }

    return deletedPaths;
  } catch (e) {
    logger.warn("Failed to cleanup old logs", { logDir, pattern, error: e });
    return [];
  }
}

import { acknowledgeRequest } from "./redis/requestHandlers.js";
import { interpretPersonaStatus } from "./agents/persona.js";
// applyModelGeneratedChanges not exported from implementation stage; omit import

// Lightweight type alias for edit outcome used in this module
type ApplyEditsOutcome = any;

// Local stub for applying model-generated changes. The real implementation
// lives in the implementation stage module in some workflows; if available
// it should be imported there. For now return a conservative result.
async function applyModelGeneratedChanges(_: any): Promise<ApplyEditsOutcome> {
  return { attempted: false, applied: false, reason: 'not_implemented' } as ApplyEditsOutcome;
}
import { gatherPromptFileSnippets, extractMentionedPaths } from "./prompt.js";
import { normalizeRepoPath, firstString, clipText, shouldUploadDashboardFlag, personaTimeoutMs, CODING_PERSONA_SET, ENGINEER_PERSONAS_REQUIRING_PLAN } from "./util.js";

/**
 * Helper function to write planning logs for implementation-planner persona
 */
async function writePlanningLog(
  repoInfo: any,
  repoRootNormalized: string,
  payloadObj: any,
  msg: any,
  resp: any,
  duration: number
) {
  const fs = await import("fs/promises");
  const pathMod = await import("path");
  const repoRoot = repoRootNormalized;
  const planningDir = pathMod.resolve(repoRoot, ".ma/planning");
  await fs.mkdir(planningDir, { recursive: true });
  
  const taskId = firstString(
    payloadObj.task_id,
    payloadObj.taskId,
    payloadObj.task?.id,
    msg.workflow_id
  ) || "unknown";
  
  const planLogPath = pathMod.resolve(planningDir, `task-${taskId}-plan.log`);
  
  // Parse planning response to extract key information
  const responseText = resp.content || "";
  const hasBreakdown = responseText.toLowerCase().includes("breakdown") || 
                      responseText.toLowerCase().includes("step");
  const hasRisks = responseText.toLowerCase().includes("risk");
  
  // Try to extract iteration number and branch from payload
  const iteration = payloadObj.iteration || payloadObj.planIteration || "unknown";
  const planBranch = payloadObj.branch || repoInfo.branch || "unknown";
  
  const logEntry = [
    `\n${"=".repeat(80)}`,
    `Planning Iteration - ${new Date().toISOString()}`,
    `Task ID: ${taskId}`,
    `Workflow ID: ${msg.workflow_id}`,
    `Branch: ${planBranch}`,
    `Iteration: ${iteration}`,
    `Has Breakdown: ${hasBreakdown}`,
    `Has Risks: ${hasRisks}`,
    `Duration: ${duration}ms`,
    `${"=".repeat(80)}`,
    ``,
    responseText,
    ``,
    `${"=".repeat(80)}`,
    ``
  ].join("\n");
  
  await fs.appendFile(planLogPath, logEntry, "utf8");
  logger.info("Planning results written to log", { 
    taskId, 
    planLogPath: pathMod.relative(repoRoot, planLogPath),
    branch: planBranch,
    iteration,
    workflowId: msg.workflow_id 
  });
  
  // Cleanup old planning logs (keep only last 5)
  const deletedLogs = await cleanupOldLogs(planningDir, "task-*-plan.log", 5);
  
  // Commit and push the planning log so other machines can access it
  try {
    const planLogRel = pathMod.relative(repoRoot, planLogPath);
    const pathsToCommit = [planLogRel];
    
    // Add deleted log paths for commit (they'll be staged as deletions)
    if (deletedLogs.length > 0) {
      for (const deletedPath of deletedLogs) {
        const relPath = pathMod.relative(repoRoot, deletedPath);
        pathsToCommit.push(relPath);
      }
    }
    
    const commitRes = await commitAndPushPaths({
      repoRoot,
      branch: payloadObj.branch || repoInfo.branch || null,
      message: `plan: iteration ${iteration} for task ${taskId}${deletedLogs.length > 0 ? ` (cleaned ${deletedLogs.length} old logs)` : ''}`,
      paths: pathsToCommit
    });
    logger.info("Planning log committed and pushed", {
      taskId,
      planLogPath: planLogRel,
      branch: planBranch,
      iteration,
      cleanedLogs: deletedLogs.length,
      commitResult: commitRes,
      workflowId: msg.workflow_id
    });
  } catch (commitErr: any) {
    logger.warn("Failed to commit planning log", {
      taskId,
      workflowId: msg.workflow_id,
      error: commitErr?.message || String(commitErr)
    });
  }
}

/**
 * Helper function to write QA logs for tester-qa persona
 */
async function writeQALog(
  repoInfo: any,
  repoRootNormalized: string,
  payloadObj: any,
  msg: any,
  resp: any,
  duration: number
) {
  const fs = await import("fs/promises");
  const pathMod = await import("path");
  const repoRoot = repoRootNormalized;
  const qaDir = pathMod.resolve(repoRoot, ".ma/qa");
  await fs.mkdir(qaDir, { recursive: true });
  
  const taskId = firstString(
    payloadObj.task_id,
    payloadObj.taskId,
    payloadObj.task?.id,
    msg.workflow_id
  ) || "unknown";
  
  const qaLogPath = pathMod.resolve(qaDir, `task-${taskId}-qa.log`);
  
  // Parse QA response to extract key information using proper status interpretation
  const responseText = resp.content || "";
  const statusInfo = interpretPersonaStatus(responseText);
  const status = statusInfo.status === "pass" ? "PASS" : 
                 statusInfo.status === "fail" ? "FAIL" : "UNKNOWN";
  
  const qaBranch = payloadObj.branch || repoInfo.branch || "unknown";
  
  const logEntry = [
    `\n${"=".repeat(80)}`,
    `QA Test Run - ${new Date().toISOString()}`,
    `Task ID: ${taskId}`,
    `Workflow ID: ${msg.workflow_id}`,
    `Branch: ${qaBranch}`,
    `Status: ${status}`,
    `Duration: ${duration}ms`,
    `${"=".repeat(80)}`,
    ``,
    responseText,
    ``,
    `${"=".repeat(80)}`,
    ``
  ].join("\n");
  
  await fs.appendFile(qaLogPath, logEntry, "utf8");
  logger.info("QA results written to log", { 
    taskId, 
    qaLogPath: pathMod.relative(repoRoot, qaLogPath),
    branch: qaBranch,
    status,
    workflowId: msg.workflow_id 
  });
  
  // Cleanup old QA logs (keep only last 5)
  const deletedLogs = await cleanupOldLogs(qaDir, "task-*-qa.log", 5);
  
  // Commit and push the QA log so other machines can access it
  try {
    const qaLogRel = pathMod.relative(repoRoot, qaLogPath);
    const pathsToCommit = [qaLogRel];
    
    // Add deleted log paths for commit (they'll be staged as deletions)
    if (deletedLogs.length > 0) {
      for (const deletedPath of deletedLogs) {
        const relPath = pathMod.relative(repoRoot, deletedPath);
        pathsToCommit.push(relPath);
      }
    }
    
    const commitRes = await commitAndPushPaths({
      repoRoot,
      branch: payloadObj.branch || repoInfo.branch || null,
      message: `qa: ${status} for task ${taskId}${deletedLogs.length > 0 ? ` (cleaned ${deletedLogs.length} old logs)` : ''}`,
      paths: pathsToCommit
    });
    logger.info("QA log committed and pushed", {
      taskId,
      qaLogPath: qaLogRel,
      branch: qaBranch,
      status,
      cleanedLogs: deletedLogs.length,
      commitResult: commitRes,
      workflowId: msg.workflow_id
    });
  } catch (commitErr: any) {
    logger.warn("Failed to commit QA log", {
      taskId,
      workflowId: msg.workflow_id,
      error: commitErr?.message || String(commitErr)
    });
  }
}

/**
 * Helper function to write Code Review logs for code-reviewer persona
 */
async function writeCodeReviewLog(
  repoInfo: any,
  repoRootNormalized: string,
  payloadObj: any,
  msg: any,
  resp: any,
  duration: number
) {
  const fs = await import("fs/promises");
  const pathMod = await import("path");
  const repoRoot = repoRootNormalized;
  const reviewsDir = pathMod.resolve(repoRoot, ".ma/reviews");
  await fs.mkdir(reviewsDir, { recursive: true });
  
  const taskId = firstString(
    payloadObj.task_id,
    payloadObj.taskId,
    payloadObj.task?.id,
    msg.workflow_id
  ) || "unknown";
  
  const reviewLogPath = pathMod.resolve(reviewsDir, `task-${taskId}-code-review.log`);
  
  // Parse code review response to extract key information
  const responseText = resp.content || "";
  const statusInfo = interpretPersonaStatus(responseText);
  const status = statusInfo.status === "pass" ? "PASS" : 
                 statusInfo.status === "fail" ? "FAIL" : "UNKNOWN";
  
  // Try to parse JSON to extract severity-organized findings
  let findings = { severe: [], high: [], medium: [], low: [] };
  let summary = "No summary provided";
  try {
    const jsonMatch = responseText.match(/```json\s*(\{[\s\S]*?\})\s*```/) || 
                     responseText.match(/(\{[\s\S]*"findings"[\s\S]*\})/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      findings = parsed.findings || findings;
      summary = parsed.summary || parsed.details || summary;
    }
  } catch (e) {
    logger.debug("Could not parse code review JSON, using raw response", { taskId });
  }
  
  const reviewBranch = payloadObj.branch || repoInfo.branch || "unknown";
  
  const logEntry = [
    `\n${"=".repeat(80)}`,
    `Code Review - ${new Date().toISOString()}`,
    `Task ID: ${taskId}`,
    `Workflow ID: ${msg.workflow_id}`,
    `Branch: ${reviewBranch}`,
    `Status: ${status}`,
    `Duration: ${duration}ms`,
    `${"=".repeat(80)}`,
    ``,
    `SUMMARY: ${summary}`,
    ``,
    `FINDINGS BY SEVERITY:`,
    ``,
    `SEVERE (${findings.severe?.length || 0}):`,
    ...(findings.severe || []).map((f: any) => 
      `  - File: ${f.file || 'N/A'}${f.line ? `:${f.line}` : ''}\n    Issue: ${f.issue || f.vulnerability || 'N/A'}\n    Recommendation: ${f.recommendation || f.mitigation || 'N/A'}`
    ),
    ``,
    `HIGH (${findings.high?.length || 0}):`,
    ...(findings.high || []).map((f: any) => 
      `  - File: ${f.file || 'N/A'}${f.line ? `:${f.line}` : ''}\n    Issue: ${f.issue || f.vulnerability || 'N/A'}\n    Recommendation: ${f.recommendation || f.mitigation || 'N/A'}`
    ),
    ``,
    `MEDIUM (${findings.medium?.length || 0}):`,
    ...(findings.medium || []).map((f: any) => 
      `  - File: ${f.file || 'N/A'}${f.line ? `:${f.line}` : ''}\n    Issue: ${f.issue || f.vulnerability || 'N/A'}\n    Recommendation: ${f.recommendation || f.mitigation || 'N/A'}`
    ),
    ``,
    `LOW (${findings.low?.length || 0}):`,
    ...(findings.low || []).map((f: any) => 
      `  - File: ${f.file || 'N/A'}${f.line ? `:${f.line}` : ''}\n    Issue: ${f.issue || f.vulnerability || 'N/A'}\n    Recommendation: ${f.recommendation || f.mitigation || 'N/A'}`
    ),
    ``,
    `${"=".repeat(80)}`,
    `FULL RESPONSE:`,
    `${"=".repeat(80)}`,
    ``,
    responseText,
    ``,
    `${"=".repeat(80)}`,
    ``
  ].join("\n");
  
  await fs.appendFile(reviewLogPath, logEntry, "utf8");
  logger.info("Code review results written to log", { 
    taskId, 
    reviewLogPath: pathMod.relative(repoRoot, reviewLogPath),
    branch: reviewBranch,
    status,
    severeCnt: findings.severe?.length || 0,
    highCnt: findings.high?.length || 0,
    mediumCnt: findings.medium?.length || 0,
    lowCnt: findings.low?.length || 0,
    workflowId: msg.workflow_id 
  });
  
  // Commit and push the review log so other machines can access it
  try {
    const reviewLogRel = pathMod.relative(repoRoot, reviewLogPath);
    const commitRes = await commitAndPushPaths({
      repoRoot,
      branch: payloadObj.branch || repoInfo.branch || null,
      message: `code-review: ${status} for task ${taskId} (severe:${findings.severe?.length || 0}, high:${findings.high?.length || 0})`,
      paths: [reviewLogRel]
    });
    logger.info("Code review log committed and pushed", {
      taskId,
      reviewLogPath: reviewLogRel,
      branch: reviewBranch,
      status,
      commitResult: commitRes,
      workflowId: msg.workflow_id
    });
  } catch (commitErr: any) {
    logger.warn("Failed to commit code review log", {
      taskId,
      workflowId: msg.workflow_id,
      error: commitErr?.message || String(commitErr)
    });
  }
}

/**
 * Helper function to write Security Review logs for security-review persona
 */
async function writeSecurityReviewLog(
  repoInfo: any,
  repoRootNormalized: string,
  payloadObj: any,
  msg: any,
  resp: any,
  duration: number
) {
  const fs = await import("fs/promises");
  const pathMod = await import("path");
  const repoRoot = repoRootNormalized;
  const reviewsDir = pathMod.resolve(repoRoot, ".ma/reviews");
  await fs.mkdir(reviewsDir, { recursive: true });
  
  const taskId = firstString(
    payloadObj.task_id,
    payloadObj.taskId,
    payloadObj.task?.id,
    msg.workflow_id
  ) || "unknown";
  
  const securityLogPath = pathMod.resolve(reviewsDir, `task-${taskId}-security-review.log`);
  
  // Parse security review response to extract key information
  const responseText = resp.content || "";
  const statusInfo = interpretPersonaStatus(responseText);
  const status = statusInfo.status === "pass" ? "PASS" : 
                 statusInfo.status === "fail" ? "FAIL" : "UNKNOWN";
  
  // Try to parse JSON to extract severity-organized findings
  let findings = { severe: [], high: [], medium: [], low: [] };
  let summary = "No summary provided";
  try {
    const jsonMatch = responseText.match(/```json\s*(\{[\s\S]*?\})\s*```/) || 
                     responseText.match(/(\{[\s\S]*"findings"[\s\S]*\})/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      findings = parsed.findings || findings;
      summary = parsed.summary || parsed.details || summary;
    }
  } catch (e) {
    logger.debug("Could not parse security review JSON, using raw response", { taskId });
  }
  
  const securityBranch = payloadObj.branch || repoInfo.branch || "unknown";
  
  const logEntry = [
    `\n${"=".repeat(80)}`,
    `Security Review - ${new Date().toISOString()}`,
    `Task ID: ${taskId}`,
    `Workflow ID: ${msg.workflow_id}`,
    `Branch: ${securityBranch}`,
    `Status: ${status}`,
    `Duration: ${duration}ms`,
    `${"=".repeat(80)}`,
    ``,
    `SUMMARY: ${summary}`,
    ``,
    `SECURITY FINDINGS BY SEVERITY:`,
    ``,
    `SEVERE (${findings.severe?.length || 0}):`,
    ...(findings.severe || []).map((f: any) => 
      `  - Category: ${f.category || 'N/A'}\n    File: ${f.file || 'N/A'}${f.line ? `:${f.line}` : ''}\n    Vulnerability: ${f.vulnerability || f.issue || 'N/A'}\n    Impact: ${f.impact || 'N/A'}\n    Mitigation: ${f.mitigation || f.recommendation || 'N/A'}`
    ),
    ``,
    `HIGH (${findings.high?.length || 0}):`,
    ...(findings.high || []).map((f: any) => 
      `  - Category: ${f.category || 'N/A'}\n    File: ${f.file || 'N/A'}${f.line ? `:${f.line}` : ''}\n    Vulnerability: ${f.vulnerability || f.issue || 'N/A'}\n    Impact: ${f.impact || 'N/A'}\n    Mitigation: ${f.mitigation || f.recommendation || 'N/A'}`
    ),
    ``,
    `MEDIUM (${findings.medium?.length || 0}):`,
    ...(findings.medium || []).map((f: any) => 
      `  - Category: ${f.category || 'N/A'}\n    File: ${f.file || 'N/A'}${f.line ? `:${f.line}` : ''}\n    Vulnerability: ${f.vulnerability || f.issue || 'N/A'}\n    Impact: ${f.impact || 'N/A'}\n    Mitigation: ${f.mitigation || f.recommendation || 'N/A'}`
    ),
    ``,
    `LOW (${findings.low?.length || 0}):`,
    ...(findings.low || []).map((f: any) => 
      `  - Category: ${f.category || 'N/A'}\n    File: ${f.file || 'N/A'}${f.line ? `:${f.line}` : ''}\n    Vulnerability: ${f.vulnerability || f.issue || 'N/A'}\n    Impact: ${f.impact || 'N/A'}\n    Mitigation: ${f.mitigation || f.recommendation || 'N/A'}`
    ),
    ``,
    `${"=".repeat(80)}`,
    `FULL RESPONSE:`,
    `${"=".repeat(80)}`,
    ``,
    responseText,
    ``,
    `${"=".repeat(80)}`,
    ``
  ].join("\n");
  
  await fs.appendFile(securityLogPath, logEntry, "utf8");
  logger.info("Security review results written to log", { 
    taskId, 
    securityLogPath: pathMod.relative(repoRoot, securityLogPath),
    branch: securityBranch,
    status,
    severeCnt: findings.severe?.length || 0,
    highCnt: findings.high?.length || 0,
    mediumCnt: findings.medium?.length || 0,
    lowCnt: findings.low?.length || 0,
    workflowId: msg.workflow_id 
  });
  
  // Commit and push the security review log so other machines can access it
  try {
    const securityLogRel = pathMod.relative(repoRoot, securityLogPath);
    const commitRes = await commitAndPushPaths({
      repoRoot,
      branch: payloadObj.branch || repoInfo.branch || null,
      message: `security-review: ${status} for task ${taskId} (severe:${findings.severe?.length || 0}, high:${findings.high?.length || 0})`,
      paths: [securityLogRel]
    });
    logger.info("Security review log committed and pushed", {
      taskId,
      securityLogPath: securityLogRel,
      branch: securityBranch,
      status,
      commitResult: commitRes,
      workflowId: msg.workflow_id
    });
  } catch (commitErr: any) {
    logger.warn("Failed to commit security review log", {
      taskId,
      workflowId: msg.workflow_id,
      error: commitErr?.message || String(commitErr)
    });
  }
}

export async function processContext(transport: MessageTransport, persona: string, msg: any, payloadObj: any, entryId: string) {
    const model = cfg.personaModels[persona]; if (!model) throw new Error(`No model mapping for '${persona}'`);
    const ctx: any = await fetchContext(msg.workflow_id);
    // Allow custom system prompt via payload, otherwise use default
    const systemPrompt = payloadObj._system_prompt || SYSTEM_PROMPTS[persona] || `You are the ${persona} agent.`;
    // --- Context scan (pre-model), supports multi-components & Alembic ---
    let scanSummaryText = "";
    let scanArtifacts: null | {
      repoRoot: string;
      ndjson: string;
      snapshot: any;
      summaryMd: string;
      branch: string | null;
      repoSlug: string | null;
      remoteUrl: string | null;
      snapshotPath: string;
      summaryPath: string;
      filesNdjsonPath: string;
      snapshotRel: string;
      summaryRel: string;
      filesNdjsonRel: string;
      totals: { files: number; bytes: number; lines: number };
      components: any;
      hotspots: any;
      paths: string[];
    } = null;
    let repoInfo: Awaited<ReturnType<typeof resolveRepoFromPayload>> | null = null;
  if (persona !== PERSONAS.COORDINATION) {
      try {
        repoInfo = await resolveRepoFromPayload(payloadObj);
      } catch (e:any) {
        logger.warn("resolve repo from payload failed", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
      }
    }
  // Use the resolved repoRoot directly for filesystem and git operations.
  // Avoid cross-OS path normalization that could produce invalid paths on Windows.
  let repoRootNormalized = repoInfo ? repoInfo.repoRoot : null;
    let dashboardUploadEnabled = false;
    const dashboardProject: { id?: string; name?: string; slug?: string } = {};
  if (persona === PERSONAS.CONTEXT && cfg.contextScan && repoInfo && repoRootNormalized) {
      try {
          const repoRoot = repoRootNormalized;
        
        // Check if there are new code commits since last context scan (excludes .ma/ metadata)
        const { hasCommitsSinceLastContextScan } = await import("./git/contextCommitCheck.js");
        const hasNewCommits = await hasCommitsSinceLastContextScan(repoRoot);
        
        // Skip scan if no new code commits since last scan
        if (!hasNewCommits) {
          scanSummaryText = "No code changes since last context scan - using existing context data";
          logger.info("context scan skipped: no code changes since last scan", {
            repoRoot,
            branch: repoInfo.branch ?? null,
            workflowId: msg.workflow_id
          });
          
          // Return early - no need to call LLM or commit anything
          const skipMessage = "Context scan skipped: no code changes detected since last scan. The existing context data is still current.";
          logger.info("persona completed (early return)", { persona, workflowId: msg.workflow_id, reason: "no_code_changes" });
          
          await publishEvent(transport, {
            workflowId: msg.workflow_id,
            taskId: msg.task_id,
            step: msg.step,
            fromPersona: persona,
            status: "done",
            result: { output: skipMessage, skipped: true, reason: "no_code_changes" },
            corrId: msg.corr_id
          });
          await acknowledgeRequest(transport, persona, entryId, true);
          return;
        } else {
        
        const components = Array.isArray(payloadObj.components) ? payloadObj.components
                          : (Array.isArray(cfg.scanComponents) ? cfg.scanComponents : null);
  
        logger.info("context scan starting", {
          repoRoot,
          branch: repoInfo.branch ?? null,
          components: components?.map((c:any) => ({ base: c.base || "", include: c.include, exclude: c.exclude })),
          include: cfg.scanInclude,
          exclude: cfg.scanExclude,
          maxFiles: cfg.scanMaxFiles,
          maxBytes: cfg.scanMaxBytes,
          maxDepth: cfg.scanMaxDepth,
          reason: 'new_code_commits_detected'
        });
  
        const { scanRepo, summarize } = await import("./scanRepo.js");
        type Comp = { base: string; include: string[]; exclude: string[] };
        const comps: Comp[] = components && components.length
          ? components.map((c:any)=>({
              base: String(c.base||"").replace(/\\/g,"/"),
              include: (c.include||cfg.scanInclude),
              exclude: (c.exclude||cfg.scanExclude)
            }))
          : [{ base: "", include: cfg.scanInclude, exclude: cfg.scanExclude }];
  
        let allFiles: any[] = [];
        const perComp: any[] = [];
        const localSummaries: { component: string; totals: any; largest: any[]; longest: any[] }[] = [];
  
        for (const c of comps) {
          const basePath = (c.base && c.base.length) ? (repoRoot.replace(/\/$/,"") + "/" + c.base.replace(/^\//,"")) : repoRoot;
          const files = await scanRepo({
            repo_root: basePath,
            include: c.include,
            exclude: c.exclude,
            max_files: cfg.scanMaxFiles,
            max_bytes: cfg.scanMaxBytes,
            max_depth: cfg.scanMaxDepth,
            track_lines: cfg.scanTrackLines,
            track_hash: cfg.scanTrackHash
          });
          const prefixed = files.map(f => ({ ...f, path: (c.base ? (c.base.replace(/^\/+|\/+$|/g,'') + '/' + f.path) : f.path) }));
          allFiles.push(...prefixed);
          const sum = summarize(prefixed);
          const compName = c.base || ".";
          perComp.push({ component: compName, totals: sum.totals, largest: sum.largest.slice(0,10), longest: sum.longest.slice(0,10) });
          localSummaries.push({ component: compName, totals: sum.totals, largest: sum.largest.slice(0,5), longest: sum.longest.slice(0,5) });
        }
  
        const ndjson = allFiles.map(f => JSON.stringify(f)).join("\n") + "\n";
        const { summarize: summarize2 } = await import("./scanRepo.js");
        const global = summarize2(allFiles);
  
        // Build scanMd with Alembic awareness and full file tree
        const scanMd = (() => {
          const lines: string[] = [];
          lines.push("# Context Snapshot (Scan)", "", `Repo: ${repoRoot}`, `Generated: ${new Date().toISOString()}`, "", "## Totals");
          lines.push(`- Files: ${global.totals.files}`, `- Bytes: ${global.totals.bytes}`, `- Lines: ${global.totals.lines}`, "", "## Components");
          for (const pc of perComp) {
            lines.push(`### ${pc.component}`, `- Files: ${pc.totals.files}`, `- Bytes: ${pc.totals.bytes}`, `- Lines: ${pc.totals.lines}`);
            lines.push(`- Largest (top 10):`);
            for (const f of pc.largest) lines.push(`  - ${f.path} (${f.bytes} bytes)`);
            lines.push(`- Longest (top 10):`);
            for (const f of pc.longest) lines.push(`  - ${f.path} (${f.lines || 0} lines)`);
            lines.push("");
          }
          
          // Add complete file tree organized by directory
          lines.push("## File Tree");
          lines.push("");
          
          // Group files by directory
          const filesByDir = new Map<string, typeof allFiles>();
          for (const file of allFiles) {
            const dirPath = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.';
            if (!filesByDir.has(dirPath)) {
              filesByDir.set(dirPath, []);
            }
            filesByDir.get(dirPath)!.push(file);
          }
          
          // Sort directories alphabetically
          const sortedDirs = Array.from(filesByDir.keys()).sort();
          
          for (const dir of sortedDirs) {
            const files = filesByDir.get(dir)!.sort((a, b) => a.path.localeCompare(b.path));
            lines.push(`### ${dir === '.' ? 'Root' : dir}`);
            lines.push("");
            for (const f of files) {
              const fileName = f.path.includes('/') ? f.path.substring(f.path.lastIndexOf('/') + 1) : f.path;
              const sizeInfo = `${f.bytes} bytes${typeof f.lines === 'number' ? `, ${f.lines} lines` : ''}`;
              lines.push(`- **${fileName}** (${sizeInfo})`);
            }
            lines.push("");
          }
          
          // Alembic detection
          const alembicFiles = allFiles.filter(f => /(^|\/)alembic(\/|$)/i.test(f.path));
          if (alembicFiles.length) {
            const versions = alembicFiles.filter(f => /(^|\/)alembic(\/|).*\bversions\b(\/|).+\.py$/i.test(f.path));
            const latest = [...versions].sort((a,b)=> (b.mtime||0) - (a.mtime||0)).slice(0, 10);
            lines.push("## Alembic Migrations");
            lines.push(`- Alembic tree detected (files: ${alembicFiles.length}, versions: ${versions.length})`);
            lines.push(versions.length ? "- Latest versions (by modified time):" : "- No versioned migrations found under alembic/versions");
            for (const f of latest) {
              lines.push(`  - ${f.path}  (mtime=${new Date(f.mtime).toISOString()}, bytes=${f.bytes}${typeof f.lines==='number'?`, lines=${f.lines}`:''})`);
            }
            lines.push("");
          }
          return lines.join("\n");
        })();
  
        const repoMeta = await getRepoMetadata(repoRoot);
        const branchUsed = repoInfo.branch ?? repoMeta.currentBranch ?? null;
        repoInfo.branch = branchUsed;
        repoInfo.remote = repoInfo.remote || repoMeta.remoteUrl || undefined;
        const repoSlug = repoMeta.remoteSlug || null;
  
        const snapshot = {
          repo: repoRoot,
          generated_at: new Date().toISOString(),
          totals: global.totals,
          files: allFiles,  // Include full file list in snapshot
          components: perComp,
          hotspots: { largest_files: global.largest, longest_files: global.longest }
        };
  
        const { writeArtifacts } = await import("./artifacts.js");
        const writeRes = await writeArtifacts({
          repoRoot,
          artifacts: { snapshot, filesNdjson: ndjson, summaryMd: scanMd },
          apply: cfg.applyEdits && cfg.allowedEditPersonas.includes("context"),
          branchName: `feat/context-${msg.workflow_id}-${(msg.corr_id||"c").slice(0,8)}`,
          commitMessage: `context: snapshot for ${msg.workflow_id}`,
          forceCommit: true // Always commit and push context scan results in distributed workflow
        });
        
        logger.info("context artifacts committed and pushed after scan", {
          workflowId: msg.workflow_id,
          applied: writeRes.applied,
          paths: writeRes.paths,
          repoRoot
        });
  
        const pathMod = await import("path");
        const contextFolder = ".ma/context";
        const snapshotRel = `${contextFolder}/snapshot.json`;
        const summaryRel = `${contextFolder}/summary.md`;
        const filesNdjsonRel = `${contextFolder}/files.ndjson`;
  
        scanArtifacts = {
          repoRoot,
          ndjson,
          snapshot,
          summaryMd: scanMd,
          branch: branchUsed,
          repoSlug,
          remoteUrl: repoInfo.remote || null,
          snapshotPath: pathMod.resolve(repoRoot, snapshotRel),
          summaryPath: pathMod.resolve(repoRoot, summaryRel),
          filesNdjsonPath: pathMod.resolve(repoRoot, filesNdjsonRel),
          snapshotRel,
          summaryRel,
          filesNdjsonRel,
          totals: global.totals,
          components: perComp,
          hotspots: snapshot.hotspots,
          paths: writeRes.paths
        };
        const branchNote = branchUsed ? `, branch=${branchUsed}` : "";
        scanSummaryText = `Context scan: files=${global.totals.files}, bytes=${global.totals.bytes}, lines=${global.totals.lines}, components=${perComp.length}${branchNote}.`;
  
        logger.info("context scan completed", {
          repoRoot,
          branch: branchUsed,
          remote: repoInfo.remote || null,
          repoSlug,
          totals: global.totals,
          components: localSummaries
        });
  
        const shouldUpload = shouldUploadDashboardFlag(payloadObj.upload_dashboard);
        if (shouldUpload) {
          dashboardUploadEnabled = true;
          const projectId = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id);
          const projectName = firstString(payloadObj.project_name, payloadObj.projectName, payloadObj.project);
          const projectSlug = firstString(payloadObj.project_slug, payloadObj.projectSlug);
          if (projectId) dashboardProject.id = projectId;
          if (projectName) dashboardProject.name = projectName;
          if (projectSlug) dashboardProject.slug = projectSlug;
        }
        } // end else block for scan check
      } catch (e:any) {
        scanSummaryText = `Context scan failed: ${String(e?.message || e)}`;
        logger.error("context scan failed", { error: e, repo: payloadObj.repo, branch: payloadObj.branch });
      }
    }
  
  if (persona === PERSONAS.CONTEXT && cfg.contextScan && !repoInfo) {
      scanSummaryText = scanSummaryText || "Context scan unavailable: repository could not be resolved.";
      logger.warn("context scan skipped: repo unresolved", { workflowId: msg.workflow_id, repo: payloadObj.repo, branch: payloadObj.branch });
    }
  
    const userPayload = msg.payload ? msg.payload : "{}";
    let externalSummary: string | null = null;
    let preferredPaths: string[] = [];
    
    // First, check if the payload contains a fresh context summary from a recent context persona run
    // This ensures we use the most up-to-date context rather than reading stale data from disk
    if (persona !== "context") {
      try {
        const contextFromPayload = payloadObj.context?.output || payloadObj.context_summary || payloadObj.context;
        if (contextFromPayload && typeof contextFromPayload === 'string' && contextFromPayload.length > 100) {
          externalSummary = contextFromPayload;
          scanSummaryText = "Context summary provided from recent context scan";
          preferredPaths = extractMentionedPaths(contextFromPayload);
          logger.info("Using fresh context summary from payload", { 
            persona, 
            workflowId: msg.workflow_id,
            summaryLength: contextFromPayload.length 
          });
        }
      } catch (e: any) {
        logger.debug("Unable to extract context from payload, will try disk", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message 
        });
      }
    }
    
    // If no fresh context in payload, fall back to reading from disk
    // Pull latest changes first to ensure we have the most recent context and QA logs
    if (!externalSummary && persona !== "context" && repoInfo && repoRootNormalized) {
      try {
        const repoRoot = repoRootNormalized;
        
        // Pull latest changes from remote to get updated context and logs
        try {
          await runGit(["pull", "--ff-only"], { cwd: repoRoot });
          logger.debug("Pulled latest changes before reading context", {
            persona,
            workflowId: msg.workflow_id,
            repoRoot
          });
        } catch (pullErr: any) {
          // Don't fail if pull fails - we'll use what we have
          logger.debug("Git pull failed, using local context", {
            persona,
            workflowId: msg.workflow_id,
            error: pullErr?.message || String(pullErr)
          });
        }
        
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        const summaryPath = pathMod.resolve(repoRoot, ".ma/context/summary.md");
        const content = await fs.readFile(summaryPath, "utf8");
        externalSummary = content;
        if (!scanSummaryText) scanSummaryText = `Context summary loaded from ${pathMod.relative(repoRoot, summaryPath)}`;
        preferredPaths = extractMentionedPaths(content);
        logger.debug("Using context summary from disk file", {
          persona,
          workflowId: msg.workflow_id,
          summaryPath: pathMod.relative(repoRoot, summaryPath)
        });
      } catch (e:any) {
        logger.debug("persona prompt: context summary unavailable", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
      }
    }
  
    if (!scanSummaryText && persona !== PERSONAS.CONTEXT && persona !== PERSONAS.COORDINATION) {
      scanSummaryText = "Context summary not available.";
    }
  
    // Load QA results for implementation-planner and plan-evaluator to inform their decisions
    let qaHistory: string | null = null;
    if ((persona === PERSONAS.IMPLEMENTATION_PLANNER || persona === PERSONAS.PLAN_EVALUATOR) && repoInfo && repoRootNormalized) {
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        const repoRoot = repoRootNormalized;
        
        const taskId = firstString(
          payloadObj.task_id,
          payloadObj.taskId,
          payloadObj.task?.id,
          msg.workflow_id
        ) || "unknown";
        
        const qaLogPath = pathMod.resolve(repoRoot, ".ma/qa", `task-${taskId}-qa.log`);
        
        try {
          const qaContent = await fs.readFile(qaLogPath, "utf8");
          // Extract only the most recent QA run (last entry in the log)
          const entries = qaContent.split("=".repeat(80)).filter(e => e.trim());
          const latestEntry = entries.length > 0 ? entries[entries.length - 1] : qaContent;
          qaHistory = latestEntry.trim();
          
          logger.info("Loaded QA history for persona", {
            persona,
            taskId,
            qaLogPath: pathMod.relative(repoRoot, qaLogPath),
            workflowId: msg.workflow_id
          });
        } catch (readErr: any) {
          // QA log doesn't exist yet - this is normal for first run
          logger.debug("QA log not found (first run?)", {
            persona,
            taskId,
            qaLogPath: pathMod.relative(repoRoot, qaLogPath)
          });
        }
      } catch (e: any) {
        logger.debug("Unable to load QA history", {
          persona,
          workflowId: msg.workflow_id,
          error: e?.message || String(e)
        });
      }
    }
  
    // Load previous planning iterations for implementation-planner to learn from past attempts
    let planningHistory: string | null = null;
    if (persona === PERSONAS.IMPLEMENTATION_PLANNER && repoInfo && repoRootNormalized) {
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        const repoRoot = repoRootNormalized;
        
        // Pull latest changes to get any planning logs from other machines
        try {
          await runGit(["pull", "--ff-only"], { cwd: repoRoot });
          logger.debug("Pulled latest planning logs before reading", {
            persona,
            workflowId: msg.workflow_id,
            repoRoot
          });
        } catch (pullErr: any) {
          // Don't fail if pull fails - we'll use what we have
          logger.debug("Git pull failed before reading planning log, using local", {
            persona,
            workflowId: msg.workflow_id,
            error: pullErr?.message || String(pullErr)
          });
        }
        
        const taskId = firstString(
          payloadObj.task_id,
          payloadObj.taskId,
          payloadObj.task?.id,
          msg.workflow_id
        ) || "unknown";
        
        const planLogPath = pathMod.resolve(repoRoot, ".ma/planning", `task-${taskId}-plan.log`);
        
        try {
          const planContent = await fs.readFile(planLogPath, "utf8");
          // Get all planning iterations to show evolution of the plan
          const entries = planContent.split("=".repeat(80)).filter(e => e.trim());
          
          if (entries.length > 0) {
            // If there are multiple iterations, show a summary of all + full text of last
            if (entries.length > 1) {
              const summary = `Previous planning iterations: ${entries.length}\n` +
                `Latest iteration:\n${entries[entries.length - 1]}`;
              planningHistory = summary.trim();
            } else {
              planningHistory = entries[0].trim();
            }
            
            logger.info("Loaded planning history for persona", {
              persona,
              taskId,
              iterations: entries.length,
              planLogPath: pathMod.relative(repoRoot, planLogPath),
              workflowId: msg.workflow_id
            });
          }
        } catch (readErr: any) {
          // Planning log doesn't exist yet - this is normal for first planning run
          logger.debug("Planning log not found (first planning iteration)", {
            persona,
            taskId,
            planLogPath: pathMod.relative(repoRoot, planLogPath)
          });
        }
      } catch (e: any) {
        logger.debug("Unable to load planning history", {
          persona,
          workflowId: msg.workflow_id,
          error: e?.message || String(e)
        });
      }
    }
  
    const scanSummaryForPrompt = scanArtifacts
      ? clipText(scanArtifacts.summaryMd, persona === PERSONAS.CONTEXT ? 8000 : 4000)
      : (externalSummary ? clipText(externalSummary, 4000) : scanSummaryText);
  
    let promptFileSnippets: any[] = [];
    if (persona !== PERSONAS.CONTEXT && repoRootNormalized) {
      promptFileSnippets = await gatherPromptFileSnippets(repoRootNormalized, preferredPaths);
    }
  
    const userLines = [
      `Intent: ${msg.intent}`,
      `Payload: ${userPayload}`,
      `Constraints/Limits: ${ctx?.limits || ""}`,
      `Persona hints: ${ctx?.personaHints || ""}`
    ];
  
    if (persona === PERSONAS.CONTEXT) {
      if (scanArtifacts) {
        userLines.push("Instruction: Use only the files, directories, and facts present in the scan summary above. If something is missing, explicitly state it was not observed.");
      } else {
        userLines.push(`Scan note: ${scanSummaryText}`);
      }
    } else {
      userLines.push(`Scan note: ${scanSummaryText}`);
    }
  
    const userText = userLines.join("\n");
  
    const messages: any[] = [
      { role: "system", content: systemPrompt }
    ];
  
    if (scanSummaryForPrompt && scanSummaryForPrompt.length) {
      const label = persona === PERSONAS.CONTEXT ? "Authoritative file scan summary" : "File scan summary";
      messages.push({ role: "system", content: `${label}:\n${scanSummaryForPrompt}` });
    }
  
    if (cfg.injectDashboardContext && (persona !== PERSONAS.CONTEXT || !scanArtifacts) && (ctx?.projectTree || ctx?.fileHotspots)) {
      messages.push({ role: "system", content: `Dashboard context (may be stale):\nTree: ${ctx?.projectTree || ""}\nHotspots: ${ctx?.fileHotspots || ""}` });
    }
  
    // Coordinator-managed short summary insertion: fetch a concise project summary (if available)
    try {
      const projectIdForSummary = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id, dashboardProject.id) || null;
      const projSummary = await fetchProjectStatusSummary(projectIdForSummary);
      if (projSummary && typeof projSummary === 'string' && projSummary.trim().length) {
        messages.push({ role: 'system', content: `Previous step summary (from dashboard):\n${projSummary.trim()}` });
      }
    } catch (err) {
      // ignore summary fetch failures
    }
  
    // Include QA test results for planners/evaluators to inform their decisions
    if (qaHistory && qaHistory.length > 0) {
      messages.push({ 
        role: 'system', 
        content: `Latest QA Test Results:\n${clipText(qaHistory, 2000)}\n\nUse this to understand what failed in previous attempts and adjust your plan accordingly.` 
      });
    }
  
    // Include previous planning iterations for planner to refine and improve
    if (planningHistory && planningHistory.length > 0) {
      messages.push({
        role: 'system',
        content: `Previous Planning Iterations:\n${clipText(planningHistory, 3000)}\n\nYou have created plans before for this task. Review the previous planning attempts above, consider what may have changed (new context, QA results, etc.), and either:\n1. Use the existing plan if it's still valid and complete\n2. Refine and improve the plan based on new information\n3. Create a new plan if requirements have changed significantly\n\nBe clear about whether you're reusing, refining, or replacing the previous plan.`
      });
    }
  
    if (promptFileSnippets.length) {
      const snippetParts: string[] = ["Existing project files for reference (read-only):"];
      for (const snippet of promptFileSnippets) {
        snippetParts.push(`File: ${snippet.path}`);
        snippetParts.push("```");
        snippetParts.push(snippet.content);
        snippetParts.push("```");
      }
      messages.push({ role: "system", content: snippetParts.join("\n") });
    }
  
  
    const personaLower = persona.toLowerCase();
    const stepLower = (msg.step || "").toLowerCase();
    const repoHint = firstString(
      payloadObj.repo,
      payloadObj.repository,
      payloadObj.remote,
      payloadObj.repo_url,
      payloadObj.repository_url,
      msg.repo
    ) || "the existing repository";
  
    if (ENGINEER_PERSONAS_REQUIRING_PLAN.has(personaLower) && stepLower === "2-plan") {
      messages.push({
        role: "system",
        content: `You are preparing an execution plan for work in ${repoHint}. This is a planning step only. Do not provide code snippets, diffs, or file changes. Respond with JSON containing a 'plan' array where each item describes a concrete numbered step (include goals, files to touch, owners if relevant, and dependencies). Add optional context such as 'risks' or 'open_questions'. Await coordinator approval before attempting any implementation.`
      });
    } else if (CODING_PERSONA_SET.has(personaLower)) {
      messages.push({
        role: "system",
        content: `You are working inside ${repoHint}. The repository already exists; modify only the necessary files. Do not generate a brand-new project scaffold. Provide concrete code edits as unified diffs that apply cleanly with \`git apply\`. Wrap each patch in \`\`\`diff\`\`\` fences. If you add or delete files, include the appropriate diff headers. Always reference existing files by their actual paths.`
      });
    }
    messages.push({ role: "user", content: userText });
  
    // Ensure we don't accidentally pass prior assistant messages as history; use only system+user messages
    const freshMessages = messages.filter(m => m && (m.role === 'system' || m.role === 'user')) as any[];
    const started = Date.now();
    // Use persona-specific timeout for LM calls so long-running personas can be configured via env
    const lmTimeoutMs = personaTimeoutMs(persona, cfg);
    logger.debug("calling LM model", { persona, model, timeoutMs: lmTimeoutMs });
    
    let resp: { content: string };
    let duration: number;
    try {
      resp = await callLMStudio(model, freshMessages, 0.2, { timeoutMs: lmTimeoutMs });
      duration = Date.now() - started;
      const responsePreview = resp.content && resp.content.length > 4000
        ? resp.content.slice(0, 4000) + "... (truncated)"
        : resp.content;
      logger.info("persona response", { persona, workflowId: msg.workflow_id, corrId: msg.corr_id || "", preview: responsePreview });
    } catch (lmError: any) {
      duration = Date.now() - started;
      logger.error("LM call failed", { persona, workflowId: msg.workflow_id, error: lmError?.message || String(lmError), duration_ms: duration });
      
      // For context persona, if scan artifacts exist, we can still return the scan summary
      if (persona === PERSONAS.CONTEXT && scanArtifacts) {
        logger.info("context scan completed but LM failed - returning scan summary", { workflowId: msg.workflow_id });
        resp = { content: scanArtifacts.summaryMd };
      } else {
        // For other personas, re-throw the error
        throw lmError;
      }
    }
  
    // After model call: write/replace summary.md per SUMMARY_MODE
    if (persona === PERSONAS.CONTEXT && scanArtifacts) {
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        const summaryPath = scanArtifacts.summaryPath || pathMod.resolve(scanArtifacts.repoRoot, ".ma/context/summary.md");
        let contentToWrite = resp.content;
        if (cfg.summaryMode === "scan") contentToWrite = scanArtifacts.summaryMd;
        if (cfg.summaryMode === "both") {
          contentToWrite = `# Model Summary\n\n${resp.content}\n\n---\n\n` + scanArtifacts.summaryMd;
        }
        await fs.mkdir(pathMod.dirname(summaryPath), { recursive: true });
        await fs.writeFile(summaryPath, contentToWrite, "utf8");
  
        // ensure the stored summaryPath reflects latest location
        scanArtifacts.summaryPath = summaryPath;
  
        const commitPaths = Array.from(new Set([
          scanArtifacts.snapshotRel,
          scanArtifacts.summaryRel,
          scanArtifacts.filesNdjsonRel
        ].filter(Boolean)));
  
        try {
          const commitRes = await commitAndPushPaths({
            repoRoot: scanArtifacts.repoRoot,
            branch: scanArtifacts.branch,
            message: `context: snapshot for ${msg.workflow_id}`,
            paths: commitPaths
          });
          logger.info("context artifacts push result", { workflowId: msg.workflow_id, result: commitRes });
        } catch (commitErr: any) {
          logger.error("context artifacts push failed", { error: commitErr, workflowId: msg.workflow_id });
        }
  
        if (dashboardUploadEnabled) {
          const repoId = scanArtifacts.repoSlug
            || dashboardProject.id
            || dashboardProject.slug
            || payloadObj.repo
            || scanArtifacts.repoRoot;
  
          logger.info("uploading context snapshot", {
            workflowId: msg.workflow_id,
            project: dashboardProject,
            repo: scanArtifacts.repoRoot,
            repoId,
            branch: scanArtifacts.branch,
            summaryPath: scanArtifacts.summaryRel,
            snapshotPath: scanArtifacts.snapshotRel,
            filesNdjsonPath: scanArtifacts.filesNdjsonRel
          });
          // Context is now hardened into the repo itself - no dashboard upload needed
          logger.debug("context snapshot committed to repo", {
            workflowId: msg.workflow_id,
            repoRoot: scanArtifacts.repoRoot,
            branch: scanArtifacts.branch
          });
        }
      } catch (e:any) {
        logger.warn("context summary write failed", { error: e });
      }
    }
  
    let editOutcome: ApplyEditsOutcome | null = null;
    if (cfg.applyEdits && cfg.allowedEditPersonas.includes(persona)) {
      try {
        if (!repoInfo) {
          repoInfo = await resolveRepoFromPayload(payloadObj);
          repoRootNormalized = repoInfo ? repoInfo.repoRoot : repoRootNormalized;
        }
        if (repoInfo) {
          const repoRootForEdits = repoRootNormalized || repoInfo.repoRoot;
          const branchHint = firstString(
            payloadObj.branch,
            payloadObj.branch_name,
            payloadObj.base_branch,
            payloadObj.default_branch,
            repoInfo.branch
          );
          editOutcome = await applyModelGeneratedChanges({
            persona,
            workflowId: msg.workflow_id,
            repoRoot: repoRootForEdits,
            branchHint,
            responseText: resp.content
          });
          if (branchHint && repoInfo) repoInfo.branch = branchHint;
        } else {
          editOutcome = { attempted: false, applied: false, reason: "repo_unresolved" };
        }
      } catch (error: any) {
        logger.error("persona apply edits failed", { persona, workflowId: msg.workflow_id, error });
        editOutcome = { attempted: true, applied: false, reason: "apply_failed", error: error?.message || String(error) };
      }
    }
  
    const result: any = { output: resp.content, model, duration_ms: duration };
    if (editOutcome) result.applied_edits = editOutcome;
    
    // Write QA results to task-specific log for tester-qa persona
    if (persona === PERSONAS.TESTER_QA && repoInfo && repoRootNormalized) {
      try {
        await writeQALog(repoInfo, repoRootNormalized, payloadObj, msg, resp, duration);
      } catch (e: any) {
        logger.warn("Failed to write QA log", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message || String(e) 
        });
      }
    }
    
    // Write planning results to task-specific log for implementation-planner persona
    if (persona === PERSONAS.IMPLEMENTATION_PLANNER && repoInfo && repoRootNormalized) {
      try {
        await writePlanningLog(repoInfo, repoRootNormalized, payloadObj, msg, resp, duration);
      } catch (e: any) {
        logger.warn("Failed to write planning log", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message || String(e) 
        });
      }
    }
    
    // Write code review results to task-specific log for code-reviewer persona
    if (persona === PERSONAS.CODE_REVIEWER && repoInfo && repoRootNormalized) {
      try {
        await writeCodeReviewLog(repoInfo, repoRootNormalized, payloadObj, msg, resp, duration);
      } catch (e: any) {
        logger.warn("Failed to write code review log", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message || String(e) 
        });
      }
    }
    
    // Write security review results to task-specific log for security-review persona
    if (persona === PERSONAS.SECURITY_REVIEW && repoInfo && repoRootNormalized) {
      try {
        await writeSecurityReviewLog(repoInfo, repoRootNormalized, payloadObj, msg, resp, duration);
      } catch (e: any) {
        logger.warn("Failed to write security review log", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message || String(e) 
        });
      }
    }
    
    logger.info("persona completed", { persona, workflowId: msg.workflow_id, taskId: msg.task_id, duration_ms: duration });
    await publishEvent(transport, {
      workflowId: msg.workflow_id,
      taskId: msg.workflow_id,
      step: msg.step,
      fromPersona: persona,
      status: "done",
      result,
      corrId: msg.corr_id
    });
    await recordEvent({ workflow_id: msg.workflow_id, step: msg.step, persona, model, duration_ms: duration, corr_id: msg.corr_id, content: resp.content }).catch(()=>{});
    await acknowledgeRequest(transport, persona, entryId, true);
  }

export async function processPersona(transport: MessageTransport, persona: string, msg: any, payloadObj: any, entryId: string) {
    const model = cfg.personaModels[persona]; if (!model) throw new Error(`No model mapping for '${persona}'`);
    const ctx: any = await fetchContext(msg.workflow_id);
    // Allow custom system prompt via payload, otherwise use default
    const systemPrompt = payloadObj._system_prompt || SYSTEM_PROMPTS[persona] || `You are the ${persona} agent.`;
    const userPayload = msg.payload ? msg.payload : "{}";
    let externalSummary: string | null = null;
    let preferredPaths: string[] = [];
    let repoInfo: Awaited<ReturnType<typeof resolveRepoFromPayload>> | null = null;
    if (persona !== PERSONAS.COORDINATION) {
      try {
        repoInfo = await resolveRepoFromPayload(payloadObj);
      } catch (e:any) {
        // For non-editing personas (e.g., summarization, PM), allow proceeding without a repo
        logger.warn("resolve repo from payload failed", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
        repoInfo = null;
      }
    }
    let repoRootNormalized = repoInfo ? normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot) : null;
    let scanSummaryText = "";
  if (persona !== "context" && repoInfo && repoRootNormalized) {
      try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        const repoRoot = repoRootNormalized;
        const summaryPath = pathMod.resolve(repoRoot, ".ma/context/summary.md");
        const content = await fs.readFile(summaryPath, "utf8");
        externalSummary = content;
        if (!scanSummaryText) scanSummaryText = `Context summary loaded from ${pathMod.relative(repoRoot, summaryPath)}`;
        preferredPaths = extractMentionedPaths(content);
      } catch (e:any) {
        logger.debug("persona prompt: context summary unavailable", { persona, workflowId: msg.workflow_id, error: e?.message || String(e) });
      }
    }
  
    if (!scanSummaryText && persona !== PERSONAS.CONTEXT && persona !== PERSONAS.COORDINATION) {
      scanSummaryText = "Context summary not available.";
    }
  
    const scanSummaryForPrompt = externalSummary ? clipText(externalSummary, 4000) : scanSummaryText;
  
    let promptFileSnippets: any[] = [];
    if (persona !== PERSONAS.CONTEXT && repoRootNormalized) {
      promptFileSnippets = await gatherPromptFileSnippets(repoRootNormalized, preferredPaths);
    }
  
    const userLines = [
      `Intent: ${msg.intent}`,
      `Payload: ${userPayload}`,
      `Constraints/Limits: ${ctx?.limits || ""}`,
      `Persona hints: ${ctx?.personaHints || ""}`
    ];
  
    userLines.push(`Scan note: ${scanSummaryText}`);
  
    const userText = userLines.join("\n");
  
    const messages: any[] = [
      { role: "system", content: systemPrompt }
    ];
  
    if (scanSummaryForPrompt && scanSummaryForPrompt.length) {
      const label = "File scan summary";
      messages.push({ role: "system", content: `${label}:\n${scanSummaryForPrompt}` });
    }
  
    if (cfg.injectDashboardContext && (ctx?.projectTree || ctx?.fileHotspots)) {
      messages.push({ role: "system", content: `Dashboard context (may be stale):\nTree: ${ctx?.projectTree || ""}\nHotspots: ${ctx?.fileHotspots || ""}` });
    }
  
    // Coordinator-managed short summary insertion: fetch a concise project summary (if available)
    try {
      const projectIdForSummary = firstString(payloadObj.project_id, payloadObj.projectId, msg.project_id) || null;
      const projSummary = await fetchProjectStatusSummary(projectIdForSummary);
      if (projSummary && typeof projSummary === 'string' && projSummary.trim().length) {
        messages.push({ role: 'system', content: `Previous step summary (from dashboard):\n${projSummary.trim()}` });
      }
    } catch (err) {
      // ignore summary fetch failures
    }
  
    if (promptFileSnippets.length) {
      const snippetParts: string[] = ["Existing project files for reference (read-only):"];
      for (const snippet of promptFileSnippets) {
        snippetParts.push(`File: ${snippet.path}`);
        snippetParts.push("```");
        snippetParts.push(snippet.content);
        snippetParts.push("```");
      }
      messages.push({ role: "system", content: snippetParts.join("\n") });
    }
  
  
    const personaLower = persona.toLowerCase();
    const stepLower = (msg.step || "").toLowerCase();
    const repoHint = firstString(
      payloadObj.repo,
      payloadObj.repository,
      payloadObj.remote,
      payloadObj.repo_url,
      payloadObj.repository_url,
      msg.repo
    ) || "the existing repository";
  
    messages.push({ role: "user", content: userText });
  
    // Ensure we don't accidentally pass prior assistant messages as history; use only system+user messages
    const freshMessages = messages.filter(m => m && (m.role === 'system' || m.role === 'user')) as any[];
    const started = Date.now();
    // Use persona-specific timeout for LM calls so long-running personas can be configured via env
    const lmTimeoutMs = personaTimeoutMs(persona, cfg);
    logger.debug("calling LM model", { persona, model, timeoutMs: lmTimeoutMs });
    const resp = await callLMStudio(model, freshMessages, 0.2, { timeoutMs: lmTimeoutMs });
    const duration = Date.now() - started;
    const responsePreview = resp.content && resp.content.length > 4000
      ? resp.content.slice(0, 4000) + "... (truncated)"
      : resp.content;
    logger.info("persona response", { persona, workflowId: msg.workflow_id, corrId: msg.corr_id || "", preview: responsePreview });
  
    let editOutcome: ApplyEditsOutcome | null = null;
    if (cfg.applyEdits && cfg.allowedEditPersonas.includes(persona)) {
      try {
        if (!repoInfo) {
          repoInfo = await resolveRepoFromPayload(payloadObj);
          repoRootNormalized = repoInfo ? normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot) : repoRootNormalized;
        }
        if (repoInfo) {
          const repoRootForEdits = repoRootNormalized || normalizeRepoPath(repoInfo.repoRoot, cfg.repoRoot);
          const branchHint = firstString(
            payloadObj.branch,
            payloadObj.branch_name,
            payloadObj.base_branch,
            payloadObj.default_branch,
            repoInfo.branch
          );
          editOutcome = await applyModelGeneratedChanges({
            persona,
            workflowId: msg.workflow_id,
            repoRoot: repoRootForEdits,
            branchHint,
            responseText: resp.content
          });
          if (branchHint && repoInfo) repoInfo.branch = branchHint;
        } else {
          editOutcome = { attempted: false, applied: false, reason: "repo_unresolved" };
        }
      } catch (error: any) {
        logger.error("persona apply edits failed", { persona, workflowId: msg.workflow_id, error });
        editOutcome = { attempted: true, applied: false, reason: "apply_failed", error: error?.message || String(error) };
      }
    }
  
    const result: any = { output: resp.content, model, duration_ms: duration };
    if (editOutcome) result.applied_edits = editOutcome;
    
    // Write QA results to task-specific log for tester-qa persona
    if (persona === PERSONAS.TESTER_QA && repoInfo && repoRootNormalized) {
      try {
        await writeQALog(repoInfo, repoRootNormalized, payloadObj, msg, resp, duration);
      } catch (e: any) {
        logger.warn("Failed to write QA log", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message || String(e) 
        });
      }
    }
    
    // Write planning results to task-specific log for implementation-planner persona
    if (persona === PERSONAS.IMPLEMENTATION_PLANNER && repoInfo && repoRootNormalized) {
      try {
        await writePlanningLog(repoInfo, repoRootNormalized, payloadObj, msg, resp, duration);
      } catch (e: any) {
        logger.warn("Failed to write planning log", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message || String(e) 
        });
      }
    }
    
    // Write code review results to task-specific log for code-reviewer persona
    if (persona === PERSONAS.CODE_REVIEWER && repoInfo && repoRootNormalized) {
      try {
        await writeCodeReviewLog(repoInfo, repoRootNormalized, payloadObj, msg, resp, duration);
      } catch (e: any) {
        logger.warn("Failed to write code review log", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message || String(e) 
        });
      }
    }
    
    // Write security review results to task-specific log for security-review persona
    if (persona === PERSONAS.SECURITY_REVIEW && repoInfo && repoRootNormalized) {
      try {
        await writeSecurityReviewLog(repoInfo, repoRootNormalized, payloadObj, msg, resp, duration);
      } catch (e: any) {
        logger.warn("Failed to write security review log", { 
          persona, 
          workflowId: msg.workflow_id, 
          error: e?.message || String(e) 
        });
      }
    }
    
    logger.info("persona completed", { persona, workflowId: msg.workflow_id, taskId: msg.task_id, duration_ms: duration });
    await publishEvent(transport, {
      workflowId: msg.workflow_id,
      taskId: msg.task_id,
      step: msg.step,
      fromPersona: persona,
      status: "done",
      result,
      corrId: msg.corr_id
    });
    await recordEvent({ workflow_id: msg.workflow_id, step: msg.step, persona, model, duration_ms: duration, corr_id: msg.corr_id, content: resp.content }).catch(()=>{});
    await acknowledgeRequest(transport, persona, entryId, true);
  }