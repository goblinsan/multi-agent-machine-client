import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";

interface TestToolingSetupConfig {
  testCommandVariable?: string;
  installCommand?: string;
  ciCommand?: string;
  ensureDevDependencies?: string[];
  skipInstall?: boolean;
  skipInstallWhenNodeModulesPresent?: boolean;
  additionalEnv?: Record<string, string>;
}

interface ToolingSetupResult {
  executedCommands: string[];
  missingDependencies: string[];
  skipped: boolean;
  reason?: string;
}

export class TestToolingSetupStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as TestToolingSetupConfig;
    const commandVariable =
      config.testCommandVariable?.trim() || "detected_test_command";
    const testCommand = context.getVariable(commandVariable);
    const repoRoot = context.repoRoot;

    if (!this.isRunnableCommand(testCommand)) {
      return this.successResult({
        executedCommands: [],
        missingDependencies: [],
        skipped: true,
        reason: "no test command detected",
      });
    }

    if (!this.targetsNodeEcosystem(String(testCommand))) {
      return this.successResult({
        executedCommands: [],
        missingDependencies: [],
        skipped: true,
        reason: "non-node test command",
      });
    }

    const packageJsonPath = path.join(repoRoot, "package.json");
    if (!(await this.pathExists(packageJsonPath))) {
      return this.successResult({
        executedCommands: [],
        missingDependencies: [],
        skipped: true,
        reason: "package.json not found",
      });
    }

    const packageJson = await this.readPackageJson(packageJsonPath);
    const ensureDeps = Array.isArray(config.ensureDevDependencies)
      ? config.ensureDevDependencies
      : this.detectRequiredDevDependencies(String(testCommand), packageJson);

    const missingDeps = ensureDeps.filter(
      (dep) => !this.hasDependency(packageJson, dep),
    );

    const executedCommands: string[] = [];

    if (missingDeps.length > 0) {
      const devInstall = `npm install --no-save ${missingDeps.join(" ")}`;
      await this.runCommand(devInstall, repoRoot, config.additionalEnv);
      executedCommands.push(devInstall);
    }

    const shouldInstall = await this.shouldInstallAllDependencies(
      repoRoot,
      config,
    );

    if (shouldInstall) {
      const lockfileAwareCommand = await this.resolveInstallCommand(
        repoRoot,
        config,
      );
      const installCommand = config.installCommand?.trim() || lockfileAwareCommand;
      await this.runCommand(installCommand, repoRoot, config.additionalEnv);
      executedCommands.push(installCommand);
    }

    const skipped = executedCommands.length === 0;

    context.setVariable("test_tooling_initialized", !skipped);
    context.setVariable("test_tooling_commands", executedCommands);
    context.setVariable(
      "test_tooling_missing_dependencies",
      missingDeps,
    );

    return this.successResult({
      executedCommands,
      missingDependencies: missingDeps,
      skipped,
    });
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as TestToolingSetupConfig;
    const errors: string[] = [];

    if (
      config.ensureDevDependencies !== undefined &&
      !Array.isArray(config.ensureDevDependencies)
    ) {
      errors.push("ensureDevDependencies must be an array when provided");
    }

    if (
      config.installCommand !== undefined &&
      typeof config.installCommand !== "string"
    ) {
      errors.push("installCommand must be a string if provided");
    }

    if (config.ciCommand !== undefined && typeof config.ciCommand !== "string") {
      errors.push("ciCommand must be a string if provided");
    }

    if (
      config.testCommandVariable !== undefined &&
      typeof config.testCommandVariable !== "string"
    ) {
      errors.push("testCommandVariable must be a string if provided");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    } satisfies ValidationResult;
  }

  private successResult(result: ToolingSetupResult): StepResult {
    return {
      status: "success",
      data: result,
      outputs: result,
    } satisfies StepResult;
  }

  private async shouldInstallAllDependencies(
    repoRoot: string,
    config: TestToolingSetupConfig,
  ): Promise<boolean> {
    if (config.skipInstall) {
      return false;
    }

    if (!config.skipInstallWhenNodeModulesPresent) {
      return true;
    }

    const nodeModulesPath = path.join(repoRoot, "node_modules");
    return !(await this.pathExists(nodeModulesPath));
  }

  private async readPackageJson<T = any>(filePath: string): Promise<T> {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  }

  private isRunnableCommand(command: unknown): command is string {
    return typeof command === "string" && command.trim().length > 0;
  }

  private targetsNodeEcosystem(command: string): boolean {
    const normalized = command.toLowerCase();
    return (
      normalized.startsWith("npm ") ||
      normalized.startsWith("npx ") ||
      normalized.includes("vitest")
    );
  }

  private detectRequiredDevDependencies(
    testCommand: string,
    packageJson: Record<string, any>,
  ): string[] {
    const deps = new Set<string>();
    const normalizedCommand = testCommand.toLowerCase();
    if (normalizedCommand.includes("vitest")) {
      deps.add("vitest");
    }

    const scripts = packageJson?.scripts || {};
    for (const scriptValue of Object.values(scripts ?? {})) {
      if (
        typeof scriptValue === "string" &&
        scriptValue.toLowerCase().includes("vitest")
      ) {
        deps.add("vitest");
      }
    }

    return Array.from(deps);
  }

  private hasDependency(
    packageJson: Record<string, any>,
    dependency: string,
  ): boolean {
    const deps = packageJson.dependencies || {};
    const devDeps = packageJson.devDependencies || {};
    return Boolean(deps[dependency] || devDeps[dependency]);
  }

  private async resolveInstallCommand(
    repoRoot: string,
    config: TestToolingSetupConfig,
  ): Promise<string> {
    const lockfilePath = await this.findLockfile(repoRoot);
    if (lockfilePath) {
      return config.ciCommand?.trim() || "npm ci";
    }
    return "npm install";
  }

  private async findLockfile(repoRoot: string): Promise<string | null> {
    const candidates = ["package-lock.json", "npm-shrinkwrap.json"];
    for (const candidate of candidates) {
      const fullPath = path.join(repoRoot, candidate);
      if (await this.pathExists(fullPath)) {
        return fullPath;
      }
    }
    return null;
  }

  private async runCommand(
    command: string,
    cwd: string,
    env?: Record<string, string>,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, ...env },
        stdio: "inherit",
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}`));
        }
      });

      child.on("error", (error) => reject(error));
    });
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
