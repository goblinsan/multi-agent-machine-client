import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { runGit } from "../../gitUtils.js";
import type { SetupCommandInsight } from "./context/contextSummary.js";

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
  gitChanges?: GitStatusEntry[];
  revertedTrackedPaths?: string[];
}

interface PlannedCommand {
  command: string;
  cwd: string;
}

interface AdjustedCommand {
  command: string;
  note?: string;
}

interface GitStatusEntry {
  path: string;
  status: string;
  untracked: boolean;
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

    const contextCommands = this.resolveContextSetupCommands(context);
    if (contextCommands.length > 0) {
      return this.executeContextDrivenSetup(contextCommands, context, config);
    }

    if (!this.targetsNodeEcosystem(String(testCommand))) {
      return this.successResult({
        executedCommands: [],
        missingDependencies: [],
        skipped: true,
        reason: "non-node test command",
      });
    }

    return this.executeLegacyNodeSetup(context, config, String(testCommand));
  }

  private async executeContextDrivenSetup(
    commands: SetupCommandInsight[],
    context: WorkflowContext,
    config: TestToolingSetupConfig,
  ): Promise<StepResult> {
    const repoRoot = context.repoRoot;
    const baselineStatus = await this.snapshotGitStatus(repoRoot);
    const orderedCommands = this.expandContextCommandList(commands);
    const executedCommands: string[] = [];

    for (const plan of orderedCommands) {
      const resolvedCwd = this.resolveCommandCwd(repoRoot, plan.cwd);
      const adjusted = await this.adjustCommandForLockfile(
        plan.command,
        resolvedCwd,
      );
      await this.runCommand(adjusted.command, resolvedCwd, config.additionalEnv);
      const recordedCommand = plan.cwd === "."
        ? adjusted.command
        : `${plan.cwd}: ${adjusted.command}`;
      executedCommands.push(adjusted.note
        ? `${recordedCommand} (${adjusted.note})`
        : recordedCommand);
    }

    const gitChanges = await this.collectGitChanges(repoRoot, baselineStatus);
    const revertedTracked = await this.revertTrackedChanges(
      repoRoot,
      gitChanges.filter((entry) => !entry.untracked),
    );
    const skipped = executedCommands.length === 0;

    context.setVariable("test_tooling_initialized", !skipped);
    context.setVariable("test_tooling_commands", executedCommands);
    context.setVariable("test_tooling_missing_dependencies", []);
    context.setVariable("test_tooling_git_changes", gitChanges);
    context.setVariable("test_tooling_reverted_paths", revertedTracked);
    context.setVariable("test_tooling_context_setup", true);

    return this.successResult({
      executedCommands,
      missingDependencies: [],
      skipped,
      gitChanges,
      revertedTrackedPaths: revertedTracked,
      reason: skipped ? "context summary listed no commands" : undefined,
    });
  }

  private expandContextCommandList(
    commands: SetupCommandInsight[],
  ): PlannedCommand[] {
    const planned: PlannedCommand[] = [];
    const seen = new Set<string>();

    commands.forEach((entry) => {
      const cwd = this.normalizeWorkingDir(entry.workingDirectory);
      entry.commands.forEach((raw) => {
        const command = raw.trim();
        if (!command) {
          return;
        }
        const key = `${cwd}::${command}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        planned.push({ command, cwd });
      });
    });

    return planned;
  }

  private normalizeWorkingDir(dir?: string): string {
    if (!dir) {
      return ".";
    }
    const trimmed = dir.trim();
    if (!trimmed || trimmed === ".") {
      return ".";
    }
    return trimmed;
  }

  private resolveContextSetupCommands(
    context: WorkflowContext,
  ): SetupCommandInsight[] {
    const raw = context.getVariable("context_setup_commands");
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((entry): entry is SetupCommandInsight => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        Array.isArray((entry as SetupCommandInsight).commands) &&
        (entry as SetupCommandInsight).commands.length > 0
      );
    });
  }

  private async snapshotGitStatus(
    repoRoot: string,
  ): Promise<Map<string, string>> {
    const result = await runGit(["status", "--porcelain"], { cwd: repoRoot });
    const statuses = new Map<string, string>();
    result.stdout
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim().length > 0)
      .forEach((line) => {
        const status = line.slice(0, 2);
        const file = line.slice(3).trim();
        if (file) {
          statuses.set(file, status);
        }
      });
    return statuses;
  }

  private async collectGitChanges(
    repoRoot: string,
    baseline: Map<string, string>,
  ): Promise<GitStatusEntry[]> {
    const current = await this.snapshotGitStatus(repoRoot);
    const changes: GitStatusEntry[] = [];
    current.forEach((status, file) => {
      const previous = baseline.get(file);
      if (previous === status) {
        return;
      }
      changes.push({
        path: file,
        status,
        untracked: status === "??",
      });
    });
    return changes;
  }

  private async revertTrackedChanges(
    repoRoot: string,
    changes: GitStatusEntry[],
  ): Promise<string[]> {
    const reverted: string[] = [];
    for (const change of changes) {
      try {
        await runGit(["checkout", "--", change.path], { cwd: repoRoot });
        reverted.push(change.path);
      } catch {
        // ignore failures to revert so tooling setup keeps moving
      }
    }
    return reverted;
  }

  private resolveCommandCwd(repoRoot: string, dir: string): string {
    if (!dir || dir === ".") {
      return repoRoot;
    }
    if (path.isAbsolute(dir)) {
      return dir;
    }
    return path.join(repoRoot, dir);
  }

  private async executeLegacyNodeSetup(
    context: WorkflowContext,
    config: TestToolingSetupConfig,
    testCommand: string,
  ): Promise<StepResult> {
    const repoRoot = context.repoRoot;
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
      const adjusted = await this.adjustCommandForLockfile(
        config.installCommand?.trim() || lockfileAwareCommand,
        repoRoot,
      );
      await this.runCommand(adjusted.command, repoRoot, config.additionalEnv);
      executedCommands.push(adjusted.note
        ? `${adjusted.command} (${adjusted.note})`
        : adjusted.command);
    }

    const skipped = executedCommands.length === 0;

    context.setVariable("test_tooling_initialized", !skipped);
    context.setVariable("test_tooling_commands", executedCommands);
    context.setVariable("test_tooling_missing_dependencies", missingDeps);
    context.setVariable("test_tooling_git_changes", []);
    context.setVariable("test_tooling_reverted_paths", []);
    context.setVariable("test_tooling_context_setup", false);

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
      return config.ciCommand?.trim() || "npm install --no-package-lock";
    }
    return "npm install --no-package-lock";
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

  private async adjustCommandForLockfile(
    command: string,
    cwd: string,
  ): Promise<AdjustedCommand> {
    if (!this.isNpmCiCommand(command)) {
      return { command };
    }

    const lockfileSynced = await this.isLockfileSynced(cwd);
    if (lockfileSynced) {
      return { command };
    }

    const fallback = this.swapNpmCiWithInstall(command);
    return {
      command: fallback,
      note: "lockfile out of sync, swapped npm ci with npm install --no-package-lock",
    };
  }

  private isNpmCiCommand(command: string): boolean {
    return /^\s*npm\s+ci\b/i.test(command);
  }

  private swapNpmCiWithInstall(command: string): string {
    return command.replace(/npm\s+ci\b/i, "npm install --no-package-lock");
  }

  private async isLockfileSynced(cwd: string): Promise<boolean> {
    const packageJsonPath = path.join(cwd, "package.json");
    const lockfilePath = await this.findLockfile(cwd);

    if (!(await this.pathExists(packageJsonPath)) || !lockfilePath) {
      return true;
    }

    try {
      const [packageJson, lockfile] = await Promise.all([
        this.readPackageJson<Record<string, any>>(packageJsonPath),
        this.readPackageJson<Record<string, any>>(lockfilePath),
      ]);
      const lockRoot = this.getLockfileRoot(lockfile);
      if (!lockRoot) {
        return true;
      }

      return (
        this.dependencyMapsMatch(
          packageJson.dependencies || {},
          lockRoot.dependencies || {},
        ) &&
        this.dependencyMapsMatch(
          packageJson.devDependencies || {},
          lockRoot.devDependencies || {},
        )
      );
    } catch {
      return true;
    }
  }

  private getLockfileRoot(lockfile: Record<string, any>): Record<string, any> | null {
    if (
      lockfile &&
      typeof lockfile === "object" &&
      lockfile.packages &&
      typeof lockfile.packages === "object"
    ) {
      const root = lockfile.packages[""];
      if (root && typeof root === "object") {
        return root;
      }
    }

    if (lockfile && typeof lockfile === "object") {
      return lockfile;
    }

    return null;
  }

  private dependencyMapsMatch(
    expected: Record<string, string>,
    actual: Record<string, string>,
  ): boolean {
    const keys = new Set([
      ...Object.keys(expected || {}),
      ...Object.keys(actual || {}),
    ]);

    for (const key of keys) {
      const expectedValue = (expected?.[key] ?? "").trim();
      const actualValue = (actual?.[key] ?? "").trim();
      if (expectedValue !== actualValue) {
        return false;
      }
    }

    return true;
  }
}
