import { logger } from "./logger.js";

/**
 * Cleanup task logs when a task is marked as completed
 * This function:
 * 1. Reads QA and planning logs for the task
 * 2. Generates a summary
 * 3. Appends summary to .ma/changelog.md
 * 4. Removes the individual task logs
 * 5. Commits and pushes the changes
 */
export async function cleanupTaskLogs(options: {
  repoRoot: string;
  taskId: string;
  taskTitle?: string;
  branch?: string | null;
}): Promise<void> {
  const { repoRoot, taskId, taskTitle, branch } = options;
  
  try {
    const fs = await import("fs/promises");
    const pathMod = await import("path");
    
    logger.info("Starting task log cleanup", { taskId, repoRoot });
    
    const qaLogPath = pathMod.resolve(repoRoot, ".ma/qa", `task-${taskId}-qa.log`);
    const planLogPath = pathMod.resolve(repoRoot, ".ma/planning", `task-${taskId}-plan.log`);
    const changelogPath = pathMod.resolve(repoRoot, ".ma", "changelog.md");
    
    let qaContent: string | null = null;
    let planContent: string | null = null;
    const logsToDelete: string[] = [];
    
    // Read QA log if it exists
    try {
      qaContent = await fs.readFile(qaLogPath, "utf8");
      logsToDelete.push(qaLogPath);
      logger.debug("Found QA log to cleanup", { taskId, qaLogPath });
    } catch (e) {
      logger.debug("No QA log found for task", { taskId });
    }
    
    // Read planning log if it exists
    try {
      planContent = await fs.readFile(planLogPath, "utf8");
      logsToDelete.push(planLogPath);
      logger.debug("Found planning log to cleanup", { taskId, planLogPath });
    } catch (e) {
      logger.debug("No planning log found for task", { taskId });
    }
    
    if (logsToDelete.length === 0) {
      logger.debug("No logs to cleanup for task", { taskId });
      return;
    }
    
    // Generate summary
    const summary = generateTaskSummary(taskId, taskTitle, qaContent, planContent);
    
    // Ensure .ma directory exists
    const maDir = pathMod.resolve(repoRoot, ".ma");
    await fs.mkdir(maDir, { recursive: true });
    
    // Append to changelog
    try {
      // Check if changelog exists
      let existingChangelog = "";
      try {
        existingChangelog = await fs.readFile(changelogPath, "utf8");
      } catch (e) {
        // Changelog doesn't exist, create header
        existingChangelog = "# Task Changelog\n\nThis file tracks completed tasks and their outcomes.\n\n";
      }
      
      const updatedChangelog = existingChangelog + "\n" + summary + "\n";
      await fs.writeFile(changelogPath, updatedChangelog, "utf8");
      logger.info("Updated changelog with task summary", { taskId, changelogPath });
    } catch (e: any) {
      logger.warn("Failed to update changelog", { taskId, error: e?.message || String(e) });
      // Continue with cleanup even if changelog update fails
    }
    
    // Delete the individual log files
    const deletedFiles: string[] = [];
    for (const logPath of logsToDelete) {
      try {
        await fs.unlink(logPath);
        deletedFiles.push(pathMod.relative(repoRoot, logPath));
        logger.debug("Deleted log file", { taskId, logPath });
      } catch (e: any) {
        logger.warn("Failed to delete log file", { 
          taskId, 
          logPath, 
          error: e?.message || String(e) 
        });
      }
    }
    
    // Commit and push changes
    try {
      const changelogRel = pathMod.relative(repoRoot, changelogPath);
      const filesToCommit = [changelogRel, ...deletedFiles];
      
      const { commitAndPushPaths } = await import("./gitUtils.js");
      const commitRes = await commitAndPushPaths({
        repoRoot,
        branch: branch || null,
        message: `chore: cleanup logs for completed task ${taskId}`,
        paths: filesToCommit
      });
      
      logger.info("Committed task log cleanup", {
        taskId,
        deletedFiles,
        commitResult: commitRes
      });
    } catch (commitErr: any) {
      logger.warn("Failed to commit task log cleanup", {
        taskId,
        error: commitErr?.message || String(commitErr)
      });
    }
    
    logger.info("Task log cleanup completed", { 
      taskId, 
      deletedLogs: deletedFiles.length,
      changelogUpdated: true 
    });
    
  } catch (e: any) {
    logger.error("Task log cleanup failed", {
      taskId,
      repoRoot,
      error: e?.message || String(e),
      stack: e?.stack
    });
  }
}

/**
 * Generate a summary of the task based on logs
 */
function generateTaskSummary(
  taskId: string, 
  taskTitle: string | undefined,
  qaContent: string | null, 
  planContent: string | null
): string {
  const timestamp = new Date().toISOString();
  const lines: string[] = [];
  
  lines.push(`## Task ${taskId}${taskTitle ? `: ${taskTitle}` : ""}`);
  lines.push(`**Completed:** ${timestamp}`);
  lines.push("");
  
  // Extract QA summary
  if (qaContent) {
    const qaEntries = qaContent.split("=".repeat(80)).filter(e => e.trim());
    const qaRuns = qaEntries.length;
    const lastEntry = qaEntries[qaEntries.length - 1] || "";
    const finalStatus = lastEntry.match(/Status: (\w+)/)?.[1] || "UNKNOWN";
    
    lines.push("### QA Summary");
    lines.push(`- Test runs: ${qaRuns}`);
    lines.push(`- Final status: ${finalStatus}`);
    
    if (finalStatus === "FAIL") {
      lines.push("- Note: Task marked complete despite failing QA (may need follow-up)");
    }
    lines.push("");
  }
  
  // Extract planning summary
  if (planContent) {
    const planEntries = planContent.split("=".repeat(80)).filter(e => e.trim());
    const iterations = planEntries.length;
    
    lines.push("### Planning Summary");
    lines.push(`- Planning iterations: ${iterations}`);
    
    // Try to extract key planning details from last iteration
    const lastPlan = planEntries[planEntries.length - 1] || "";
    const hasBreakdown = lastPlan.includes("Has Breakdown: true");
    const hasRisks = lastPlan.includes("Has Risks: true");
    
    if (hasBreakdown) {
      lines.push("- Plan included task breakdown");
    }
    if (hasRisks) {
      lines.push("- Risks were identified and addressed");
    }
    lines.push("");
  }
  
  lines.push("---");
  lines.push("");
  
  return lines.join("\n");
}
