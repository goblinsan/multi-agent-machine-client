import fs from "fs/promises";
import path from "path";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { runTestCommandWithWorker } from "../helpers/testRunner.js";
import { TaskAPI } from "../../dashboard/TaskAPI.js";
import { logger } from "../../logger.js";

interface TaskRealityAuditConfig {
  enabled?: boolean;
  run_typecheck?: boolean;
  run_tests?: boolean;
  typecheck_command?: string;
  test_command?: string;
  timeout_ms?: number;
  update_task_status?: boolean;
  resolved_status?: string;
}

interface CommandAuditResult {
  command: string;
  skipped?: boolean;
  passed?: boolean;
  reason?: string;
  stdout?: string;
  stderr?: string;
}

interface Evidence {
  taskText: string;
  mentionedPaths: string[];
  existingPaths: string[];
  missingPaths: string[];
  symbols: string[];
  foundSymbols: string[];
  missingSymbols: string[];
  typecheck: CommandAuditResult;
  tests?: CommandAuditResult;
}

const taskAPI = new TaskAPI();

export class TaskRealityAuditStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as TaskRealityAuditConfig;
    if (config.enabled === false) {
      return this.recordDecision(context, false, "audit_disabled", {
        taskText: "",
        mentionedPaths: [],
        existingPaths: [],
        missingPaths: [],
        symbols: [],
        foundSymbols: [],
        missingSymbols: [],
        typecheck: { command: "", skipped: true, reason: "audit disabled" },
      });
    }

    const task = context.getVariable("task") || {};
    const taskText = this.getTaskText(task);
    const repoRoot = context.repoRoot;
    const mentionedPaths = this.extractMentionedPaths(taskText);
    const existingPaths = await this.filterExistingPaths(repoRoot, mentionedPaths);
    const missingPaths = mentionedPaths.filter(
      (candidate) => !existingPaths.includes(candidate),
    );
    const symbols = this.extractSymbols(taskText);
    const foundSymbols = await this.findSymbols(repoRoot, symbols);
    const missingSymbols = symbols.filter((symbol) => !foundSymbols.includes(symbol));

    const typecheck = config.run_typecheck === false
      ? { command: "", skipped: true, reason: "typecheck disabled" }
      : await this.runCommandAudit(
          repoRoot,
          config.typecheck_command || (await this.detectTypecheckCommand(repoRoot)),
          config.timeout_ms || 60000,
        );

    const tests = config.run_tests
      ? await this.runCommandAudit(
          repoRoot,
          config.test_command || (await this.detectTestCommand(repoRoot)),
          config.timeout_ms || 120000,
        )
      : undefined;

    const evidence: Evidence = {
      taskText,
      mentionedPaths,
      existingPaths,
      missingPaths,
      symbols,
      foundSymbols,
      missingSymbols,
      typecheck,
      tests,
    };

    const decision = this.decide(evidence);
    if (decision.alreadyResolved && config.update_task_status !== false) {
      await this.markTaskResolved(context, task, config.resolved_status || "completed", decision.reason);
    }

    return this.recordDecision(
      context,
      decision.alreadyResolved,
      decision.reason,
      evidence,
      decision.confidence,
    );
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as TaskRealityAuditConfig;
    const errors: string[] = [];
    if (
      config.timeout_ms !== undefined &&
      (typeof config.timeout_ms !== "number" || config.timeout_ms < 1000)
    ) {
      errors.push("TaskRealityAuditStep: timeout_ms must be a number >= 1000");
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  private getTaskText(task: any): string {
    return [
      task.title,
      task.name,
      task.description,
      task.details,
      Array.isArray(task.labels) ? task.labels.join(" ") : "",
    ]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();
  }

  private extractMentionedPaths(text: string): string[] {
    const matches = text.match(
      /(?:[\w.-]+\/)+[\w.@-]+\.[A-Za-z0-9]+|(?<!@)\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|css|html|py|go|rs|java|kt|swift|yaml|yml)\b/g,
    ) || [];
    return Array.from(
      new Set(
        matches
          .map((match) => match.replace(/^['"`]+|['"`.,;:)]+$/g, ""))
          .filter((match) => !match.includes("..")),
      ),
    );
  }

  private extractSymbols(text: string): string[] {
    const symbols = new Set<string>();
    const explicit = text.match(/`([A-Za-z_$][\w$]{2,})`/g) || [];
    for (const match of explicit) {
      symbols.add(match.slice(1, -1));
    }

    const symbolPattern =
      /\b(?:function|method|class|component|hook|endpoint|handler|helper|util|utility|module)\s+([A-Za-z_$][\w$]{2,})\b/gi;
    let match: RegExpExecArray | null;
    while ((match = symbolPattern.exec(text)) !== null) {
      symbols.add(match[1]);
    }
    return Array.from(symbols);
  }

  private async filterExistingPaths(repoRoot: string, candidates: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const candidate of candidates) {
      try {
        await fs.access(this.insideRepo(repoRoot, candidate));
        out.push(candidate);
      } catch {
        void 0;
      }
    }
    return out;
  }

  private async findSymbols(repoRoot: string, symbols: string[]): Promise<string[]> {
    if (!symbols.length) return [];
    const files = await this.collectSearchFiles(repoRoot);
    const found = new Set<string>();
    for (const file of files) {
      let content = "";
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const symbol of symbols) {
        if (found.has(symbol)) continue;
        const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`).test(content)) {
          found.add(symbol);
        }
      }
      if (found.size === symbols.length) break;
    }
    return Array.from(found);
  }

  private async collectSearchFiles(repoRoot: string): Promise<string[]> {
    const out: string[] = [];
    const allowed = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".json",
      ".md",
      ".css",
      ".html",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".kt",
      ".swift",
      ".yaml",
      ".yml",
    ]);

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || out.length >= 1000) return;
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true }) as any;
      } catch {
        return;
      }
      for (const entry of entries) {
        if ([".git", "node_modules", "dist", "build", ".ma"].includes(entry.name)) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
          out.push(full);
        }
      }
    };

    await walk(repoRoot, 0);
    return out;
  }

  private async detectTypecheckCommand(repoRoot: string): Promise<string | null> {
    const pkg = await this.readPackageJson(repoRoot);
    if (pkg?.scripts?.typecheck) return "npm run typecheck";
    try {
      await fs.access(path.join(repoRoot, "node_modules", ".bin", "tsc"));
      return "./node_modules/.bin/tsc --noEmit";
    } catch {
      void 0;
    }
    try {
      await fs.access(path.join(repoRoot, "tsconfig.json"));
      return "npx tsc --noEmit";
    } catch {
      return null;
    }
  }

  private async detectTestCommand(repoRoot: string): Promise<string | null> {
    const pkg = await this.readPackageJson(repoRoot);
    if (!pkg?.scripts || typeof pkg.scripts !== "object") return null;
    for (const key of ["test:regression", "test:ci", "test"]) {
      if (typeof pkg.scripts[key] === "string") {
        return key === "test" ? "npm test" : `npm run ${key}`;
      }
    }
    return null;
  }

  private async readPackageJson(repoRoot: string): Promise<any | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    } catch {
      return null;
    }
  }

  private async runCommandAudit(
    repoRoot: string,
    command: string | null,
    timeoutMs: number,
  ): Promise<CommandAuditResult> {
    if (!command) {
      return { command: "", skipped: true, reason: "no command detected" };
    }
    try {
      const result = await runTestCommandWithWorker({
        cwd: repoRoot,
        command,
        timeoutMs,
        idleTimeoutMs: Math.min(timeoutMs, 30000),
      });
      return {
        command,
        passed: true,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 4000),
      };
    } catch (error: any) {
      return {
        command,
        passed: false,
        stdout: String(error?.stdout || "").slice(0, 4000),
        stderr: String(error?.stderr || error?.message || "").slice(0, 4000),
      };
    }
  }

  private decide(evidence: Evidence): {
    alreadyResolved: boolean;
    reason: string;
    confidence: "low" | "medium" | "high";
  } {
    const lower = evidence.taskText.toLowerCase();
    const isDiagnosticFix =
      /\b(fix|resolve|repair|bug|broken|failing|failure|error|regression|compile|typecheck|tsc|typescript|lint)\b/.test(lower);
    const isCompileFix =
      /\b(compile|typecheck|tsc|typescript|ts\d{4}|type error|build error)\b/.test(lower);
    const isFeature =
      /\b(add|create|implement|support|feature|introduce|build|write|scaffold)\b/.test(lower);

    if (isCompileFix && evidence.typecheck.passed === true) {
      return {
        alreadyResolved: true,
        reason: "compile_or_typecheck_task_has_clean_diagnostics",
        confidence: "high",
      };
    }

    if (
      isDiagnosticFix &&
      !isFeature &&
      evidence.mentionedPaths.length > 0 &&
      evidence.existingPaths.length === 0
    ) {
      return {
        alreadyResolved: true,
        reason: "fix_target_no_longer_exists",
        confidence: "high",
      };
    }

    if (
      isDiagnosticFix &&
      !isFeature &&
      evidence.symbols.length > 0 &&
      evidence.foundSymbols.length === 0
    ) {
      return {
        alreadyResolved: true,
        reason: "fix_target_symbol_no_longer_exists",
        confidence: "medium",
      };
    }

    return {
      alreadyResolved: false,
      reason: "task_still_requires_work_or_audit_inconclusive",
      confidence: "low",
    };
  }

  private async markTaskResolved(
    context: WorkflowContext,
    task: any,
    status: string,
    reason: string,
  ): Promise<void> {
    const taskId = task?.id || task?.taskId || context.getVariable("taskId");
    const projectId = context.getVariable("projectId") || context.getVariable("project_id");
    if (!taskId || !projectId) {
      logger.warn("TaskRealityAuditStep: cannot update task status, missing taskId/projectId", {
        workflowId: context.workflowId,
        taskId,
        projectId,
      });
      return;
    }
    await taskAPI.updateTaskStatus(String(taskId), status, String(projectId));
    context.setVariable("taskStatus", status);
    context.setVariable("task_status", status);
    context.setVariable("taskCompleted", true);
    context.setVariable("taskId", taskId);
    logger.info("TaskRealityAuditStep: auto-completed already resolved task", {
      workflowId: context.workflowId,
      taskId,
      projectId,
      status,
      reason,
    });
  }

  private recordDecision(
    context: WorkflowContext,
    alreadyResolved: boolean,
    reason: string,
    evidence: Evidence,
    confidence: "low" | "medium" | "high" = "low",
  ): StepResult {
    context.setVariable("task_audit_already_resolved", alreadyResolved);
    context.setVariable("task_audit_reason", reason);
    context.setVariable("task_audit_confidence", confidence);
    context.setVariable("task_audit_evidence", evidence);
    if (alreadyResolved) {
      context.setVariable("workflow_stop_requested", true);
      context.setVariable("workflow_stop_reason", reason);
    }

    return {
      status: "success",
      data: { alreadyResolved, reason, confidence, evidence },
      outputs: {
        already_resolved: alreadyResolved,
        task_audit_already_resolved: alreadyResolved,
        reason,
        confidence,
        evidence,
      },
    };
  }

  private insideRepo(repoRoot: string, relPath: string): string {
    const full = path.resolve(repoRoot, relPath);
    const normalizedRoot = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
    if (!full.startsWith(normalizedRoot)) {
      throw new Error(`Path escapes repository: ${relPath}`);
    }
    return full;
  }
}
