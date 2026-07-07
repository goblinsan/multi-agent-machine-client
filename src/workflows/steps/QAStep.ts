import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { runTestCommandWithWorker } from "../helpers/testRunner.js";

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
  };
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

    logger.info("Starting QA execution", {
      testCommand,
      testPath,
      timeout,
      retryCount,
      failureThreshold,
      requiredCoverage,
    });

    try {
      const contextData = context.getVariable("context");
      const workingDir = contextData?.metadata?.repoPath || process.cwd();

      let lastError: Error | null = null;
      let qaResult: QAResult | null = null;

      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          qaResult = await this.executeTests(
            workingDir,
            testCommand,
            testPath,
            timeout,
            idleTimeoutMs,
          );
          break;
        } catch (error: any) {
          lastError = error;
          logger.warn(`QA execution attempt ${attempt + 1} failed`, {
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

      if (!qaResult) {
        if (skipOnNoTests && lastError?.message.includes("no tests found")) {
          logger.info("No tests found, skipping QA step");
          return {
            status: "skipped",
            data: { reason: "No tests found" },
          };
        }
        if (softFail) {
          const errorMessage = lastError
            ? lastError.message
            : "QA execution failed after all retries";
          logger.warn("QA execution failed but softFail enabled", {
            error: errorMessage,
            testCommand,
          });
          context.setVariable("qaResult", null);
          context.setVariable("testsPassed", false);
          context.setVariable("failures", []);
          return {
            status: "success",
            data: {
              error: errorMessage,
              executed: false,
              command: testCommand,
              status: "error",
            },
            outputs: {
              qaResult: null,
              testsPassed: false,
              failures: [],
              error: errorMessage,
              executed: false,
              status: "error",
            },
          } satisfies StepResult;
        }
        throw lastError || new Error("QA execution failed after all retries");
      }

      const total = qaResult.testResults.total;
      const failed = qaResult.testResults.failed;
      const exitCode = qaResult.metadata.exitCode;

      let qaStatus: "success" | "failure" = "success";
      const issues: string[] = [];

      if (typeof exitCode === "number" && exitCode !== 0) {
        qaStatus = "failure";
        issues.push(`Test command exited with code ${exitCode}`);
      }

      if (total > 0) {
        const failureRate = (failed / total) * 100;
        if (failureRate > failureThreshold) {
          qaStatus = "failure";
          issues.push(
            `Test failure rate ${failureRate.toFixed(1)}% exceeds threshold ${failureThreshold}%`,
          );
        }
      } else if (failed > 0) {
        qaStatus = "failure";
        issues.push(`${failed} test failure(s) detected`);
      } else if (qaStatus === "success" && !qaResult.metadata.outputParsed) {
        logger.warn(
          "Test output format not recognized - trusting exit code only",
          { command: qaResult.metadata.command, exitCode },
        );
      }

      const passRate =
        total > 0
          ? (qaResult.testResults.passed / total) * 100
          : qaStatus === "success"
            ? 100
            : 0;

      if (requiredCoverage && qaResult.coverage) {
        if (qaResult.coverage.percentage < requiredCoverage) {
          qaStatus = "failure";
          issues.push(
            `Coverage ${qaResult.coverage.percentage.toFixed(1)}% below required ${requiredCoverage}%`,
          );
        }
      }

      context.setVariable("qaResult", qaResult);
      context.setVariable("testsPassed", qaStatus === "success");
      context.setVariable("failures", qaResult.failures);

      logger.info("QA execution completed", {
        status: qaStatus,
        totalTests: qaResult.testResults.total,
        passed: qaResult.testResults.passed,
        failed: qaResult.testResults.failed,
        passRate: passRate.toFixed(1) + "%",
        duration: qaResult.testResults.duration_ms,
        issues: issues.length,
      });

      const finalStatus = qaStatus === "failure" && softFail ? "success" : qaStatus;

      return {
        status: finalStatus,
        data: qaResult,
        outputs: {
          qaResult,
          testsPassed: qaStatus === "success",
          failures: qaResult.failures,
          status: qaStatus,
        },
        metrics: {
          duration_ms: qaResult.testResults.duration_ms,
          operations_count: qaResult.testResults.total,
        },
        error:
          qaStatus === "failure" && !softFail
            ? new Error(`QA failed: ${issues.join(", ")}`)
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
