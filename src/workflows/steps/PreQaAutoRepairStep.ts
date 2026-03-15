import fs from "fs/promises";
import path from "path";
import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { runGit } from "../../gitUtils.js";
import { validateStructuredContent } from "../../fileops/hunkHelpers.js";
import {
  parseTestErrors,
} from "./helpers/reviewNormalizationTypes.js";
import { runTestCommandWithWorker } from "../helpers/testRunner.js";

interface PreQaAutoRepairConfig {
  maxRepairAttempts?: number;
  testTimeoutMs?: number;
  testIdleTimeoutMs?: number;
}

interface RepairAttempt {
  file: string;
  line: number;
  message: string;
  repaired: boolean;
  strategy?: string;
  error?: string;
}

export class PreQaAutoRepairStep extends WorkflowStep {
  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const startTime = Date.now();
    const config = (this.config.config || {}) as PreQaAutoRepairConfig;
    const maxAttempts = config.maxRepairAttempts ?? 2;
    const testTimeoutMs = config.testTimeoutMs ?? 120000;
    const testIdleTimeoutMs = config.testIdleTimeoutMs ?? 30000;

    const preQaTestError = context.getVariable("pre_qa_test_error");
    if (!preQaTestError || typeof preQaTestError !== "string" || preQaTestError.trim().length === 0) {
      return {
        status: "success",
        data: { skipped: true, reason: "no_pre_qa_errors" },
        outputs: { repair_attempted: false, repairs: [] },
      };
    }

    const parsed = parseTestErrors(preQaTestError);
    if (parsed.length === 0) {
      return {
        status: "success",
        data: { skipped: true, reason: "no_parseable_errors" },
        outputs: { repair_attempted: false, repairs: [] },
      };
    }

    const repoRoot = context.repoRoot;
    const repairs: RepairAttempt[] = [];
    const repairedFiles: string[] = [];

    for (const syntaxError of parsed) {
      const absFile = path.isAbsolute(syntaxError.file)
        ? syntaxError.file
        : path.join(repoRoot, syntaxError.file);

      const attempt = await this.attemptRepair(absFile, syntaxError, repoRoot);
      repairs.push(attempt);
      if (attempt.repaired) {
        const relPath = path.relative(repoRoot, absFile);
        repairedFiles.push(relPath);
      }
    }

    if (repairedFiles.length === 0) {
      logger.info("Pre-QA auto-repair: no files could be repaired", {
        stepName: this.config.name,
        errorCount: parsed.length,
        repairs,
      });
      return {
        status: "success",
        data: { repaired: false, repairs },
        outputs: { repair_attempted: true, repair_succeeded: false, repairs },
      };
    }

    let verifyPassed = false;
    const testCommand = context.getVariable("detected_test_command");
    if (testCommand && typeof testCommand === "string") {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const result = await runTestCommandWithWorker({
            command: testCommand,
            cwd: repoRoot,
            timeoutMs: testTimeoutMs,
            idleTimeoutMs: testIdleTimeoutMs,
          });
          const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
          const reErrors = parseTestErrors(combined);
          if (reErrors.length === 0) {
            verifyPassed = true;
            break;
          }
        } catch {
          logger.debug("Pre-QA auto-repair: verification attempt failed", {
            attempt: attempt + 1,
          });
        }
      }
    } else {
      const allValid = repairedFiles.every((relPath) => {
        try {
          const absPath = path.join(repoRoot, relPath);
          const content = require("fs").readFileSync(absPath, "utf-8");
          return validateStructuredContent(absPath, content) === null;
        } catch {
          return false;
        }
      });
      verifyPassed = allValid;
    }

    if (!verifyPassed) {
      for (const relPath of repairedFiles) {
        try {
          await runGit(["checkout", "--", relPath], { cwd: repoRoot });
        } catch {
          void 0;
        }
      }

      logger.warn("Pre-QA auto-repair: reverted repairs (verification failed)", {
        stepName: this.config.name,
        repairedFiles,
      });

      return {
        status: "success",
        data: { repaired: false, reverted: true, repairs },
        outputs: { repair_attempted: true, repair_succeeded: false, repairs },
      };
    }

    try {
      await runGit(["add", ...repairedFiles], { cwd: repoRoot });
      await runGit(
        ["commit", "-m", `fix(auto-repair): resolve syntax errors in ${repairedFiles.join(", ")}`],
        { cwd: repoRoot },
      );
      await runGit(["push"], { cwd: repoRoot });
    } catch (gitErr: any) {
      logger.warn("Pre-QA auto-repair: git commit/push failed", {
        error: gitErr?.message,
      });
    }

    context.setVariable("pre_qa_test_error", "");
    context.setVariable("pre_qa_test_status", true);

    logger.info("Pre-QA auto-repair: successfully repaired syntax errors", {
      stepName: this.config.name,
      repairedFiles,
      repairCount: repairedFiles.length,
    });

    return {
      status: "success",
      data: { repaired: true, repairedFiles, repairs },
      outputs: {
        repair_attempted: true,
        repair_succeeded: true,
        repaired_files: repairedFiles,
        repairs,
      },
      metrics: {
        duration_ms: Date.now() - startTime,
        operations_count: repairedFiles.length,
      },
    };
  }

  private async attemptRepair(
    absFile: string,
    syntaxError: { file: string; line: number; message: string },
    repoRoot: string,
  ): Promise<RepairAttempt> {
    const base: Omit<RepairAttempt, "repaired"> = {
      file: syntaxError.file,
      line: syntaxError.line,
      message: syntaxError.message,
    };

    let content: string;
    try {
      content = await fs.readFile(absFile, "utf-8");
    } catch {
      return { ...base, repaired: false, error: "file_not_found" };
    }

    const preError = validateStructuredContent(absFile, content);
    if (!preError) {
      return { ...base, repaired: false, error: "no_structural_issue_detected" };
    }

    const message = syntaxError.message.toLowerCase();
    let repaired: string | null = null;
    let strategy: string | undefined;

    if (preError.includes("Unbalanced braces")) {
      repaired = this.repairBraceImbalance(content, absFile);
      strategy = "brace_balance";
    } else if (preError.includes("Unbalanced parentheses")) {
      repaired = this.repairParenImbalance(content);
      strategy = "paren_balance";
    } else if (preError.includes("Unbalanced brackets")) {
      repaired = this.repairBracketImbalance(content);
      strategy = "bracket_balance";
    } else if (message.includes("unexpected") && message.includes("export")) {
      repaired = this.repairDuplicateExport(content, syntaxError.line);
      strategy = "duplicate_export";
    }

    if (!repaired) {
      repaired = this.repairByGitBaseRecovery(absFile, repoRoot, content);
      strategy = repaired ? "git_base_recovery" : undefined;
    }

    if (!repaired) {
      return { ...base, repaired: false, error: `no_repair_strategy_for: ${preError}` };
    }

    const postError = validateStructuredContent(absFile, repaired);
    if (postError) {
      return { ...base, repaired: false, strategy, error: `repair_still_invalid: ${postError}` };
    }

    try {
      await fs.writeFile(absFile, repaired, "utf-8");
    } catch (writeErr: any) {
      return { ...base, repaired: false, strategy, error: `write_failed: ${writeErr?.message}` };
    }

    return { ...base, repaired: true, strategy };
  }

  private repairBraceImbalance(content: string, filePath: string): string | null {
    const lines = content.split("\n");
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    const diff = openBraces - closeBraces;

    if (diff > 0 && diff <= 3) {
      const closings = "\n" + "}\n".repeat(diff);
      return content.trimEnd() + closings;
    }

    if (diff < 0 && Math.abs(diff) <= 3) {
      return this.removeTrailingExtraBraces(lines, Math.abs(diff));
    }

    const duplicateRepair = this.repairDuplicateBlocks(content, filePath);
    if (duplicateRepair) {
      return duplicateRepair;
    }

    return null;
  }

  private removeTrailingExtraBraces(lines: string[], count: number): string | null {
    let removed = 0;
    for (let i = lines.length - 1; i >= 0 && removed < count; i--) {
      if (lines[i].trim() === "}") {
        lines.splice(i, 1);
        removed++;
      }
    }
    return removed === count ? lines.join("\n") + "\n" : null;
  }

  private repairDuplicateBlocks(content: string, _filePath: string): string | null {
    const lines = content.split("\n");
    const half = Math.floor(lines.length / 2);

    if (lines.length < 10) {
      return null;
    }

    for (let splitPoint = half - 5; splitPoint <= half + 5; splitPoint++) {
      if (splitPoint <= 0 || splitPoint >= lines.length) {
        continue;
      }
      const firstHalf = lines.slice(0, splitPoint).join("\n");
      const secondHalf = lines.slice(splitPoint).join("\n").trim();

      if (this.similarity(firstHalf, secondHalf) > 0.85) {
        const candidate = firstHalf + "\n";
        if (validateStructuredContent(_filePath, candidate) === null) {
          return candidate;
        }
      }
    }
    return null;
  }

  private similarity(a: string, b: string): number {
    if (a.length === 0 && b.length === 0) return 1;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;

    let matches = 0;
    const chunkSize = 50;
    for (let i = 0; i < shorter.length; i += chunkSize) {
      const chunk = shorter.slice(i, i + chunkSize);
      if (longer.includes(chunk)) {
        matches++;
      }
    }
    const totalChunks = Math.ceil(shorter.length / chunkSize);
    return totalChunks > 0 ? matches / totalChunks : 0;
  }

  private repairParenImbalance(content: string): string | null {
    const openParens = (content.match(/\(/g) || []).length;
    const closeParens = (content.match(/\)/g) || []).length;
    const diff = openParens - closeParens;

    if (diff > 0 && diff <= 2) {
      return content.trimEnd() + "\n" + ")".repeat(diff) + "\n";
    }

    return null;
  }

  private repairBracketImbalance(content: string): string | null {
    const openBrackets = (content.match(/\[/g) || []).length;
    const closeBrackets = (content.match(/\]/g) || []).length;
    const diff = openBrackets - closeBrackets;

    if (diff > 0 && diff <= 2) {
      return content.trimEnd() + "\n" + "]".repeat(diff) + "\n";
    }

    return null;
  }

  private repairDuplicateExport(content: string, errorLine: number): string | null {
    const lines = content.split("\n");
    if (errorLine <= 0 || errorLine > lines.length) {
      return null;
    }

    const idx = errorLine - 1;
    const line = lines[idx];
    if (!line || !line.trimStart().startsWith("export")) {
      return null;
    }

    let braceDepth = 0;
    for (let i = 0; i < idx; i++) {
      braceDepth += (lines[i].match(/\{/g) || []).length;
      braceDepth -= (lines[i].match(/\}/g) || []).length;
    }

    if (braceDepth > 0) {
      const closings = "}\n".repeat(braceDepth);
      const before = lines.slice(0, idx).join("\n") + "\n" + closings;
      const after = lines.slice(idx).join("\n");
      return before + after + "\n";
    }

    return null;
  }

  private repairByGitBaseRecovery(
    absFile: string,
    repoRoot: string,
    currentContent: string,
  ): string | null {
    try {
      const relPath = path.relative(repoRoot, absFile);
      const { execSync } = require("child_process");
      const baseContent = execSync(
        `git show HEAD~1:${relPath}`,
        { cwd: repoRoot, encoding: "utf-8", timeout: 5000 },
      ) as string;

      if (validateStructuredContent(absFile, baseContent) === null) {
        return baseContent;
      }
    } catch {
      void 0;
    }
    return null;
  }
}
