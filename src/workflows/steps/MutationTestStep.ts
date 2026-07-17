import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import {
  collectTestSources,
  findCoveringTests,
  hasRuntimeExport,
  isSourceFile,
} from "../helpers/testCoverage.js";
import { Mutant, generateMutants } from "../helpers/mutationOperators.js";

interface MutationTestConfig {
  testCommand?: string;
  changed_files?: string[];
  output_prefix?: string;
  max_mutants_per_file?: number;
  max_files?: number;
  mutant_timeout_ms?: number;
  severity?: "severe" | "high" | "medium" | "low";
  block_on_survivors?: boolean;
  exclude?: string[];
}

export interface SurvivingMutant {
  file: string;
  line: number;
  operator: string;
  original: string;
  mutated: string;
}

export class MutationTestStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = (this.config.config || {}) as MutationTestConfig;
    const prefix = config.output_prefix || this.config.name || "mutation";
    const repoRoot = context.repoRoot;

    const testCommand = this.resolveValue(config.testCommand, context);
    if (!testCommand) {
      return this.report(context, prefix, [], 0, "no_test_command");
    }

    const changed = this.resolveChangedFiles(config, context).filter(
      (file) => isSourceFile(file) && !this.isExcluded(file, config.exclude),
    );
    if (changed.length === 0) {
      return this.report(context, prefix, [], 0, "no_source_changes");
    }

    const testSources = await collectTestSources(repoRoot);
    const maxFiles = config.max_files ?? 5;
    const maxMutants = config.max_mutants_per_file ?? 10;
    const timeoutMs = config.mutant_timeout_ms ?? 120000;

    const targets: Array<{ file: string; tests: string[]; source: string }> = [];
    for (const file of changed) {
      if (targets.length >= maxFiles) break;
      let source: string;
      try {
        source = await fs.readFile(path.join(repoRoot, file), "utf-8");
      } catch {
        continue;
      }
      if (!hasRuntimeExport(source)) continue;
      const tests = findCoveringTests(file, testSources);
      if (tests.length === 0) continue;
      targets.push({ file, tests, source });
    }

    if (targets.length === 0) {
      return this.report(context, prefix, [], 0, "no_covered_source_changes");
    }

    const survivors: SurvivingMutant[] = [];
    let evaluated = 0;

    for (const target of targets) {
      const mutants = generateMutants(target.file, target.source, maxMutants);
      if (mutants.length === 0) continue;

      const command = `${testCommand} ${target.tests.join(" ")}`;
      const baseline = await this.runTests(command, repoRoot, timeoutMs);
      if (baseline.passed !== true) {
        logger.warn(
          "Skipping mutation testing for a file whose covering tests do not pass first",
          { file: target.file, tests: target.tests },
        );
        continue;
      }

      for (const mutant of mutants) {
        const killed = await this.evaluateMutant(
          repoRoot,
          target.file,
          target.source,
          mutant,
          command,
          timeoutMs,
        );
        evaluated++;
        if (!killed) {
          survivors.push({
            file: mutant.file,
            line: mutant.line,
            operator: mutant.operator,
            original: mutant.original,
            mutated: mutant.mutated,
          });
        }
      }
    }

    return this.report(
      context,
      prefix,
      survivors,
      evaluated,
      survivors.length > 0 ? "survivors_found" : "all_mutants_killed",
      config,
    );
  }

  private async evaluateMutant(
    repoRoot: string,
    file: string,
    original: string,
    mutant: Mutant,
    command: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const fullPath = path.join(repoRoot, file);
    try {
      await fs.writeFile(fullPath, mutant.text, "utf-8");
      const result = await this.runTests(command, repoRoot, timeoutMs);
      if (result.timedOut) return true;
      return result.passed === false;
    } catch (error) {
      logger.warn("Mutant evaluation failed, treating the mutant as killed", {
        file,
        line: mutant.line,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    } finally {
      await fs.writeFile(fullPath, original, "utf-8");
    }
  }

  private runTests(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<{ passed: boolean | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(command, { cwd, shell: true, stdio: "ignore" });
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ passed: null, timedOut: true });
      }, timeoutMs);

      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ passed: null, timedOut: false });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ passed: code === 0, timedOut: false });
      });
    });
  }

  private report(
    context: WorkflowContext,
    prefix: string,
    survivors: SurvivingMutant[],
    evaluated: number,
    reason: string,
    config: MutationTestConfig = {},
  ): StepResult {
    const blocking = config.block_on_survivors === true && survivors.length > 0;
    const status = blocking ? "fail" : "pass";
    const score =
      evaluated > 0
        ? Math.round(((evaluated - survivors.length) / evaluated) * 100)
        : null;

    const result = {
      status,
      reason,
      mutants_evaluated: evaluated,
      mutants_survived: survivors.length,
      mutation_score: score,
      survivors,
      severity: config.severity || "medium",
    };

    context.setVariable(`${prefix}_result`, result);
    context.setVariable(`${prefix}_status`, status);
    context.setVariable(`${prefix}_survivors`, survivors);

    logger.info("Mutation testing completed", {
      reason,
      evaluated,
      survived: survivors.length,
      score,
      status,
    });

    return {
      status: blocking ? "failure" : "success",
      data: result,
      outputs: {
        [`${prefix}_result`]: result,
        [`${prefix}_status`]: status,
        [`${prefix}_survivors`]: survivors,
      },
      ...(blocking
        ? {
            error: new Error(
              `${survivors.length} mutant(s) survived: the tests do not constrain the changed code.`,
            ),
          }
        : {}),
    };
  }

  private resolveChangedFiles(
    config: MutationTestConfig,
    context: WorkflowContext,
  ): string[] {
    const raw =
      config.changed_files || context.getVariable("review_diff_files") || [];
    return Array.from(
      new Set(
        raw
          .map((file: any) => String(file || "").trim().replace(/\\/g, "/"))
          .filter((file: string) => file && !file.startsWith(".ma/")),
      ),
    );
  }

  private isExcluded(file: string, exclude?: string[]): boolean {
    if (!exclude || exclude.length === 0) return false;
    return exclude.some((pattern) => {
      const regex = new RegExp(
        `^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
      );
      return regex.test(file);
    });
  }

  private resolveValue(
    value: string | undefined,
    context: WorkflowContext,
  ): string {
    if (!value) return "";
    const resolved = value.replace(/\$\{([^}]+)\}/g, (match, expr) => {
      const key = String(expr).split("||")[0].trim();
      const found = context.getVariable(key);
      return found === undefined || found === null ? "" : String(found);
    });
    return resolved.trim();
  }

  async validate(_context: WorkflowContext): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }
}
