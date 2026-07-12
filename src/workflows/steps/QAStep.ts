import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { runTestCommandWithWorker } from "../helpers/testRunner.js";
import { canonicalizeTypecheckMessage } from "./helpers/implementationStages.js";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import * as path from "path";

const QA_SIGNATURE_VERSION = "v2";

function qaTypecheckSignature(err: { file: string; code: string; message: string }): string {
  const normalizedFile = err.file.replace(/\\/g, "/");
  return `${normalizedFile}:${err.code}:${canonicalizeTypecheckMessage(err.message)}`;
}

export interface QAConfig {
  testCommand?: string;
  testPath?: string;
  timeout?: number;
  idleTimeoutMs?: number;
  retryCount?: number;
  failureThreshold?: number;
  requiredCoverage?: number;
  skipOnNoTests?: boolean;
  softFail?: boolean;
}

export interface QAResult {
  passed: boolean;
  testResults: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration_ms: number;
  };
  coverage?: {
    percentage: number;
    lines: { covered: number; total: number };
    functions: { covered: number; total: number };
  };
  failures: Array<{
    test: string;
    error: string;
    file?: string;
    line?: number;
  }>;
  metadata: {
    executedAt: number;
    command: string;
    workingDir: string;
    exitCode?: number;
    outputParsed?: boolean;
    preExistingFailuresCount?: number;
  };
}

interface TypecheckResult {
  passed: boolean;
  errors: Array<{
    file: string;
    line?: number;
    code: string;
    message: string;
  }>;
  output: string;
}

export class QAStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as QAConfig;
    const {
      testCommand = "npm test",
      testPath,
      timeout = 300000,
      idleTimeoutMs,
      retryCount = 1,
      failureThreshold = 0,
      requiredCoverage,
      skipOnNoTests = false,
      softFail = false,
    } = config;

    logger.info("Starting QA execution (delta-based)", {
      testCommand,
      testPath,
      timeout,
      retryCount,
      failureThreshold,
      requiredCoverage,
    });

    try {
      const contextData = context.getVariable("context");
      const workingDir =
        contextData?.metadata?.repoPath || context.repoRoot || process.cwd();

      const headTcResult = await this.runTypecheck(workingDir, 60000);
      const headTcErrors = headTcResult.errors;

      let lastError: Error | null = null;
      let headQaResult: QAResult | null = null;

      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          headQaResult = await this.executeTests(
            workingDir,
            testCommand,
            testPath,
            timeout,
            idleTimeoutMs,
          );
          break;
        } catch (error: any) {
          lastError = error;
          logger.warn(`QA test execution attempt ${attempt + 1} failed`, {
            error: error.message,
            attempt: attempt + 1,
            maxAttempts: retryCount + 1,
          });

          if (attempt < retryCount) {
            const delay = Math.min(2000 * Math.pow(2, attempt), 10000);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (!headQaResult) {
        if (skipOnNoTests && lastError?.message.includes("no tests found")) {
          logger.info("No tests found, skipping QA step");
          return {
            status: "skipped",
            data: { reason: "No tests found" },
          };
        }
        throw lastError || new Error("QA test execution failed after all retries");
      }

      const hasHeadFailures = headTcErrors.length > 0 || headQaResult.failures.length > 0 || !headQaResult.passed;

      if (!hasHeadFailures) {
        context.setVariable("qaResult", headQaResult);
        context.setVariable("testsPassed", true);
        context.setVariable("failures", []);

        return {
          status: "success",
          data: headQaResult,
          outputs: {
            qaResult: headQaResult,
            testsPassed: true,
            failures: [],
            failureFiles: [],
            errorText: "",
            status: "success",
          },
        };
      }

      const baseBranch = context.getVariable("baseBranch") || context.getVariable("base_branch") || "main";
      const baseCommit = this.gitGetMergeBase(workingDir, baseBranch);

      if (!baseCommit) {
        logger.warn("Could not determine base commit SHA. Bypassing delta-based checking (failing absolute).");
        return this.returnAbsoluteFail(headQaResult, headTcErrors, softFail);
      }

      const baseQA = await this.getBaseFailures(
        workingDir,
        baseCommit,
        testCommand,
        testPath,
        timeout,
        idleTimeoutMs
      );

      const runStartCommit = this.resolveRunStartCommit(context, workingDir, baseCommit);
      const gateQA = runStartCommit && runStartCommit !== baseCommit
        ? await this.getBaseFailures(
            workingDir,
            runStartCommit,
            testCommand,
            testPath,
            timeout,
            idleTimeoutMs
          )
        : baseQA;

      const tcErrorSignature = qaTypecheckSignature;

      const headTcSignatures = headTcErrors.map(tcErrorSignature);
      const newTcSignatures = headTcSignatures.filter(sig => !gateQA.typecheckErrors.includes(sig));
      const newTcErrors = headTcErrors.filter(err => newTcSignatures.includes(tcErrorSignature(err)));
      const inheritedTcErrors = headTcErrors.filter(err => {
        const sig = tcErrorSignature(err);
        return !baseQA.typecheckErrors.includes(sig) && gateQA.typecheckErrors.includes(sig);
      });

      const testFailureSignature = (fail: { file?: string; test: string }) => {
        const normalizedFile = fail.file ? fail.file.replace(/\\/g, "/").split("/").pop() : "";
        return `${normalizedFile}:${fail.test}`;
      };

      const headTestSignatures = headQaResult.failures.map(testFailureSignature);
      const newTestSignatures = headTestSignatures.filter(sig => !gateQA.testFailures.includes(sig));
      const newTestFailures = headQaResult.failures.filter(fail => newTestSignatures.includes(testFailureSignature(fail)));
      const inheritedTestFailures = headQaResult.failures.filter(fail => {
        const sig = testFailureSignature(fail);
        return !baseQA.testFailures.includes(sig) && gateQA.testFailures.includes(sig);
      });

      const preExistingTcCount = headTcErrors.length - newTcErrors.length;
      const preExistingTestCount = headQaResult.failures.length - newTestFailures.length;
      const totalPreExistingCount = preExistingTcCount + preExistingTestCount;

      if (inheritedTcErrors.length > 0 || inheritedTestFailures.length > 0) {
        logger.warn(
          "Regressions inherited from commits before this run - reporting without failing the current task",
          {
            baseCommit,
            runStartCommit,
            inheritedTcErrors: inheritedTcErrors.map(err => tcErrorSignature(err)).slice(0, 10),
            inheritedTestFailures: inheritedTestFailures.map(fail => testFailureSignature(fail)).slice(0, 10),
          }
        );
        context.setVariable("qa_inherited_regressions", {
          base_commit: baseCommit,
          run_start_commit: runStartCommit,
          typecheck_errors: inheritedTcErrors,
          test_failures: inheritedTestFailures,
        });
      }

      logger.info("Delta-based QA review results", {
        baseCommit,
        runStartCommit: runStartCommit || undefined,
        totalHeadTcErrors: headTcErrors.length,
        newTcErrors: newTcErrors.length,
        inheritedTcErrors: inheritedTcErrors.length,
        preExistingTcErrors: preExistingTcCount,
        totalHeadTestFailures: headQaResult.failures.length,
        newTestFailures: newTestFailures.length,
        inheritedTestFailures: inheritedTestFailures.length,
        preExistingTestFailures: preExistingTestCount,
      });

      const hasRegressions = newTcErrors.length > 0 || newTestFailures.length > 0;

      const deltaQaResult: QAResult = {
        passed: !hasRegressions,
        testResults: {
          total: headQaResult.testResults.total,
          passed: headQaResult.testResults.passed + preExistingTestCount,
          failed: newTestFailures.length,
          skipped: headQaResult.testResults.skipped,
          duration_ms: headQaResult.testResults.duration_ms,
        },
        coverage: headQaResult.coverage,
        failures: [
          ...newTcErrors.map(err => ({
            test: `Typecheck: ${err.file}`,
            error: `${err.file}:${err.line} - error ${err.code}: ${err.message}`,
            file: err.file,
            line: err.line,
          })),
          ...newTestFailures,
        ],
        metadata: {
          ...headQaResult.metadata,
          preExistingFailuresCount: totalPreExistingCount,
        },
      };

      let qaStatus: "success" | "failure" = hasRegressions ? "failure" : "success";

      context.setVariable("qaResult", deltaQaResult);
      context.setVariable("testsPassed", qaStatus === "success");
      context.setVariable("failures", deltaQaResult.failures);
      const failureFiles = this.extractFailureFiles(deltaQaResult.failures);
      const errorText = this.formatFailureText(deltaQaResult.failures);

      const finalStatus = qaStatus === "failure" && softFail ? "success" : qaStatus;

      return {
        status: finalStatus,
        data: deltaQaResult,
        outputs: {
          qaResult: deltaQaResult,
          testsPassed: qaStatus === "success",
          failures: deltaQaResult.failures,
          failureFiles,
          errorText,
          status: qaStatus,
        },
        error:
          qaStatus === "failure" && !softFail
            ? new Error(`QA failed with regressions: ${newTcErrors.length} typecheck and ${newTestFailures.length} test failures. (${totalPreExistingCount} pre-existing bypassed)`)
            : undefined,
      };

    } catch (error: any) {
      logger.error("QA execution failed", {
        error: error.message,
        step: this.config.name,
      });

      return {
        status: "failure",
        error: new Error(`QA execution failed: ${error.message}`),
      };
    }
  }

  private returnAbsoluteFail(headQaResult: QAResult, tcErrors: Array<any>, softFail: boolean): StepResult {
    const combinedFailures = [
      ...tcErrors.map(err => ({
        test: `Typecheck: ${err.file}`,
        error: `${err.file}:${err.line} - error ${err.code}: ${err.message}`,
        file: err.file,
        line: err.line,
      })),
      ...headQaResult.failures,
    ];

    const absoluteQaResult: QAResult = {
      passed: false,
      testResults: {
        ...headQaResult.testResults,
        failed: combinedFailures.length,
      },
      coverage: headQaResult.coverage,
      failures: combinedFailures,
      metadata: headQaResult.metadata,
    };

    return {
      status: softFail ? "success" : "failure",
      data: absoluteQaResult,
      outputs: {
        qaResult: absoluteQaResult,
        testsPassed: false,
        failures: combinedFailures,
        failureFiles: this.extractFailureFiles(combinedFailures),
        errorText: this.formatFailureText(combinedFailures),
        status: "failure",
      },
      error: !softFail ? new Error(`QA failed: ${combinedFailures.length} absolute errors`) : undefined,
    };
  }

  private extractFailureFiles(
    failures: Array<{ file?: string }>,
  ): string[] {
    return Array.from(
      new Set(
        failures
          .map((failure) => failure.file?.replace(/\\/g, "/").trim())
          .filter((file): file is string => Boolean(file)),
      ),
    );
  }

  private formatFailureText(
    failures: Array<{ error?: string; file?: string; line?: number }>,
  ): string {
    return failures
      .map((failure) => {
        if (failure.error && failure.error.trim().length > 0) {
          return failure.error.trim();
        }
        if (failure.file) {
          const line = failure.line ? `:${failure.line}` : "";
          return `${failure.file}${line}: failure`;
        }
        return "";
      })
      .filter((line) => line.length > 0)
      .join("\n");
  }

  private async runTypecheck(
    workingDir: string,
    timeoutMs: number = 60000
  ): Promise<TypecheckResult> {
    let command = "npx tsc --noEmit";
    try {
      const pkgPath = path.join(workingDir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.scripts && pkg.scripts.typecheck) {
          command = "npm run typecheck";
        }
      }
    } catch {
      void 0;
    }

    logger.info("Executing typecheck command", { command, workingDir });

    try {
      const { output, exitCode } = await this.runCommand(command, workingDir, timeoutMs);
      const errors = this.parseTypecheckOutput(output);
      return {
        passed: exitCode === 0 && errors.length === 0,
        errors,
        output,
      };
    } catch (e: any) {
      logger.warn("Typecheck run failed with error", { error: e.message });
      return {
        passed: false,
        errors: [{ file: "compiler", code: "TS_RUN_ERR", message: e.message }],
        output: e.message,
      };
    }
  }

  private parseTypecheckOutput(output: string): Array<{ file: string; line?: number; code: string; message: string }> {
    const lines = output.split("\n");
    const errors: Array<{ file: string; line?: number; code: string; message: string }> = [];
    const lineRegex = /^([^(]+)\((\d+),\d+\): error (TS\d+): (.+)$/;
    for (const line of lines) {
      const match = line.trim().match(lineRegex);
      if (match) {
        errors.push({
          file: match[1].trim(),
          line: parseInt(match[2]),
          code: match[3].trim(),
          message: match[4].trim(),
        });
      }
    }
    return errors;
  }

  private gitGetMergeBase(workingDir: string, baseBranch: string): string {
    const candidates = [
      `origin/${baseBranch}`,
      baseBranch,
      `origin/main`,
      `main`,
      `origin/master`,
      `master`,
    ];
    for (const cand of candidates) {
      try {
        const sha = execSync(`git merge-base ${cand} HEAD`, { cwd: workingDir, encoding: "utf8" }).trim();
        if (sha) return sha;
      } catch {
      void 0;
    }
    }
    try {
      return execSync(`git rev-parse HEAD~1`, { cwd: workingDir, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  }

  private resolveRunStartCommit(
    context: WorkflowContext,
    workingDir: string,
    baseCommit: string,
  ): string {
    const candidate = context.getVariable("implementation_baseline_commit");
    if (typeof candidate !== "string" || !/^[0-9a-f]{7,40}$/i.test(candidate)) {
      return "";
    }
    if (candidate === baseCommit) return "";
    try {
      execSync(`git cat-file -e ${candidate}^{commit}`, { cwd: workingDir });
      execSync(`git merge-base --is-ancestor ${baseCommit} ${candidate}`, { cwd: workingDir });
      return candidate;
    } catch {
      logger.warn("Recorded run-start commit is not usable for QA gating, falling back to merge base", {
        candidate,
        baseCommit,
      });
      return "";
    }
  }

  private async getBaseFailures(
    workingDir: string,
    baseCommit: string,
    testCommand: string,
    testPath?: string,
    timeoutMs: number = 300000,
    idleTimeoutMs?: number,
  ): Promise<{ typecheckErrors: string[]; testFailures: string[] }> {
    const cacheDir = path.join(workingDir, ".ma");
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    const cachePath = path.join(cacheDir, `base_qa_cache_${QA_SIGNATURE_VERSION}_${baseCommit}.json`);

    if (existsSync(cachePath)) {
      try {
        logger.info("Using cached base QA results", { baseCommit });
        return JSON.parse(readFileSync(cachePath, "utf-8"));
      } catch (e: any) {
        logger.warn("Failed to parse base QA cache, re-running", { error: e.message });
      }
    }

    logger.info("Base QA results not cached. Running base ref validation...", { baseCommit });

    let isDirty = false;
    let originalCommit = "";
    try {
      originalCommit = execSync("git rev-parse HEAD", { cwd: workingDir, encoding: "utf-8" }).trim();
      const statusOutput = execSync("git status --porcelain", { cwd: workingDir, encoding: "utf-8" }).trim();
      isDirty = statusOutput.length > 0;

      if (isDirty) {
        logger.info("Stashing dirty working directory files before checking out base ref");
        execSync("git stash --include-untracked -m 'temp_base_qa_stash'", { cwd: workingDir });
      }

      logger.info(`Checking out base commit: ${baseCommit}`);
      execSync(`git checkout ${baseCommit}`, { cwd: workingDir });

      let typecheckCmd = "npx tsc --noEmit";
      try {
        const pkgPath = path.join(workingDir, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          if (pkg.scripts && pkg.scripts.typecheck) {
            typecheckCmd = "npm run typecheck";
          }
        }
      } catch {
      void 0;
    }

      let baseTcErrors: string[] = [];
      try {
        const tcRes = await this.runCommand(typecheckCmd, workingDir, 60000);
        baseTcErrors = this.parseTypecheckOutput(tcRes.output).map(qaTypecheckSignature);
      } catch (tcErr: any) {
        if (tcErr.stdout || tcErr.stderr) {
          const out = [tcErr.stdout, tcErr.stderr].filter(Boolean).join("\n");
          baseTcErrors = this.parseTypecheckOutput(out).map(qaTypecheckSignature);
        }
      }

      let baseTestFailures: string[] = [];
      try {
        let fullCommand = testCommand;
        if (testPath) {
          fullCommand += ` ${testPath}`;
        }
        const testRes = await this.runCommand(fullCommand, workingDir, timeoutMs, idleTimeoutMs);
        const parsed = this.parseTestOutput(testRes.output);
        baseTestFailures = parsed.failures.map((fail: any) => {
          const normalizedFile = fail.file ? fail.file.replace(/\\/g, "/").split("/").pop() : "";
          return `${normalizedFile}:${fail.test}`;
        });
      } catch (testErr: any) {
        if (testErr.stdout || testErr.stderr) {
          const out = [testErr.stdout, testErr.stderr].filter(Boolean).join("\n");
          baseTestFailures = this.parseTestOutput(out).failures.map((fail: any) => {
            const normalizedFile = fail.file ? fail.file.replace(/\\/g, "/").split("/").pop() : "";
            return `${normalizedFile}:${fail.test}`;
          });
        }
      }

      const results = {
        typecheckErrors: baseTcErrors,
        testFailures: baseTestFailures,
      };

      try {
        writeFileSync(cachePath, JSON.stringify(results, null, 2), "utf-8");
        logger.info("Saved base QA results to cache file", { cachePath });
      } catch (writeErr: any) {
        logger.warn("Failed to write base QA cache file", { error: writeErr.message });
      }

      return results;
    } finally {
      try {
        if (originalCommit) {
          logger.info(`Checking back out to original commit: ${originalCommit}`);
          execSync(`git checkout ${originalCommit}`, { cwd: workingDir });
        }
        if (isDirty) {
          logger.info("Unstashing dirty working directory files");
          execSync("git stash pop", { cwd: workingDir });
        }
      } catch (restoreErr: any) {
        logger.error("CRITICAL: Failed to restore git state after base QA run", { error: restoreErr.message });
      }
    }
  }

  private async executeTests(
    workingDir: string,
    command: string,
    testPath?: string,
    timeoutMs: number = 300000,
    idleTimeoutMs?: number,
  ): Promise<QAResult> {
    const startTime = Date.now();

    let fullCommand = command;
    if (testPath) {
      fullCommand += ` ${testPath}`;
    }

    logger.debug("Executing test command", {
      command: fullCommand,
      workingDir,
      timeoutMs,
    });

    try {
      const { output, exitCode } = await this.runCommand(
        fullCommand,
        workingDir,
        timeoutMs,
        idleTimeoutMs,
      );

      const duration_ms = Date.now() - startTime;

      const parsed = this.parseTestOutput(output);
      const outputParsed = parsed.total > 0 || parsed.passed > 0 || parsed.failed > 0;

      if (exitCode !== 0 && parsed.failed === 0) {
        parsed.failed = Math.max(1, parsed.failed);
        parsed.total = Math.max(parsed.total, parsed.passed + parsed.failed);
        parsed.failures.push({
          test: "test command",
          error: `Command exited with code ${exitCode}. Output tail:\n${output.slice(-2000)}`,
        });
      }

      return {
        passed: exitCode === 0 && parsed.failed === 0,
        testResults: {
          total: parsed.total,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          duration_ms,
        },
        coverage: parsed.coverage,
        failures: parsed.failures,
        metadata: {
          executedAt: Date.now(),
          command: fullCommand,
          workingDir,
          exitCode,
          outputParsed,
        },
      };
    } catch (error: any) {
      logger.error("Test execution failed", {
        error: error.message,
        command: fullCommand,
        workingDir,
      });
      throw error;
    }
  }

  private async runCommand(
    command: string,
    workingDir: string,
    timeoutMs: number,
    idleTimeoutMs?: number,
  ): Promise<{ output: string; exitCode: number }> {
    try {
      const result = await runTestCommandWithWorker({
        command,
        cwd: workingDir,
        timeoutMs,
        idleTimeoutMs,
      });
      return {
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        exitCode: 0,
      };
    } catch (error: any) {
      if (
        typeof error?.exitCode === "number" &&
        !error?.timedOut &&
        !error?.idleTimedOut
      ) {
        return {
          output: [error.stdout, error.stderr].filter(Boolean).join("\n"),
          exitCode: error.exitCode,
        };
      }
      throw error;
    }
  }

  private parseTestOutput(output: string): any {
    const lines = output.split("\n");

    let total = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failures: Array<{
      test: string;
      error: string;
      file?: string;
      line?: number;
    }> = [];
    let coverage: any = null;

    for (const line of lines) {
      const jestMatch = line.match(
        /Tests:\s*(?:(\d+)\s*failed,\s*)?(?:(\d+)\s*skipped,\s*)?(?:(\d+)\s*passed,\s*)?(\d+)\s*total/,
      );
      if (jestMatch) {
        failed = jestMatch[1] ? parseInt(jestMatch[1]) : 0;
        skipped = jestMatch[2] ? parseInt(jestMatch[2]) : 0;
        passed = jestMatch[3] ? parseInt(jestMatch[3]) : 0;
        total = parseInt(jestMatch[4]);
        if (passed === 0 && failed === 0 && skipped === 0) {
          passed = total;
        }
      }

      const vitestMatch = line.match(
        /^\s*Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(?:(\d+)\s+skipped\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/,
      );
      if (vitestMatch) {
        failed = vitestMatch[1] ? parseInt(vitestMatch[1]) : 0;
        skipped = vitestMatch[2] ? parseInt(vitestMatch[2]) : 0;
        passed = parseInt(vitestMatch[3]);
        total = parseInt(vitestMatch[4]);
      }

      if (/^=+.*\bin\s+[\d.]+s.*=+$/.test(line) || /^=+ .*(passed|failed).*=+$/.test(line)) {
        const pyFailed = line.match(/(\d+)\s+failed/);
        const pyPassed = line.match(/(\d+)\s+passed/);
        const pySkipped = line.match(/(\d+)\s+skipped/);
        const pyErrors = line.match(/(\d+)\s+errors?/);
        if (pyFailed || pyPassed) {
          failed = (pyFailed ? parseInt(pyFailed[1]) : 0) + (pyErrors ? parseInt(pyErrors[1]) : 0);
          passed = pyPassed ? parseInt(pyPassed[1]) : 0;
          skipped = pySkipped ? parseInt(pySkipped[1]) : 0;
          total = passed + failed + skipped;
        }
      }

      if (line.match(/✓\s*(\d+)\s*passed/)) {
        const match = line.match(/✓\s*(\d+)\s*passed/);
        if (match) passed = parseInt(match[1]);
      }

      if (line.match(/✗\s*(\d+)\s*failed/)) {
        const match = line.match(/✗\s*(\d+)\s*failed/);
        if (match) failed = parseInt(match[1]);
      }

      if (line.includes("FAIL") || line.includes("✗")) {
        const errorMatch = line.match(/(.+?)\s+(FAIL|✗)\s+(.+)/);
        if (errorMatch) {
          failures.push({
            test: errorMatch[3] || "Unknown test",
            error: line,
            file: errorMatch[1],
          });
        }
      }

      if (line.includes("All files") && line.includes("%")) {
        const coverageMatch = line.match(/(\d+\.?\d*)%/);
        if (coverageMatch) {
          coverage = {
            percentage: parseFloat(coverageMatch[1]),
            lines: { covered: 0, total: 0 },
            functions: { covered: 0, total: 0 },
          };
        }
      }
    }

    if (total === 0 && (passed > 0 || failed > 0)) {
      total = passed + failed + skipped;
    }

    return {
      total,
      passed,
      failed,
      skipped,
      failures,
      coverage,
    };
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as any;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (
      config.testCommand !== undefined &&
      typeof config.testCommand !== "string"
    ) {
      errors.push("QAStep: testCommand must be a string");
    }

    if (config.testPath !== undefined && typeof config.testPath !== "string") {
      errors.push("QAStep: testPath must be a string");
    }

    if (
      config.timeout !== undefined &&
      (typeof config.timeout !== "number" || config.timeout < 1000)
    ) {
      errors.push("QAStep: timeout must be a number >= 1000");
    }

    if (
      config.retryCount !== undefined &&
      (typeof config.retryCount !== "number" || config.retryCount < 0)
    ) {
      errors.push("QAStep: retryCount must be a non-negative number");
    }

    if (
      config.failureThreshold !== undefined &&
      (typeof config.failureThreshold !== "number" ||
        config.failureThreshold < 0 ||
        config.failureThreshold > 100)
    ) {
      errors.push(
        "QAStep: failureThreshold must be a number between 0 and 100",
      );
    }

    if (
      config.requiredCoverage !== undefined &&
      (typeof config.requiredCoverage !== "number" ||
        config.requiredCoverage < 0 ||
        config.requiredCoverage > 100)
    ) {
      errors.push(
        "QAStep: requiredCoverage must be a number between 0 and 100",
      );
    }

    if (
      config.skipOnNoTests !== undefined &&
      typeof config.skipOnNoTests !== "boolean"
    ) {
      errors.push("QAStep: skipOnNoTests must be a boolean");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async cleanup(context: WorkflowContext): Promise<void> {
    const qaResult = context.getVariable("qaResult");
    if (qaResult) {
      logger.debug("Cleaning up QA test results");
    }
  }
}
