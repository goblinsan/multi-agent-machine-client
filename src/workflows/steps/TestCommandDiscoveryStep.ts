import fs from "fs/promises";
import path from "path";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import {
  TestCommandManifest,
  TestCommandCandidate,
} from "./helpers/TestCommandManifest.js";

interface TestCommandDiscoveryConfig {
  variable?: string;
  require_command?: boolean;
  package_script_priority?: string[];
  allow_makefile?: boolean;
}

interface DetectionResult {
  command: string;
  source: string;
  details?: Record<string, unknown>;
}

export class TestCommandDiscoveryStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as TestCommandDiscoveryConfig;
    const variableName = config.variable || "detected_test_command";
    const requireCommand = config.require_command ?? true;
    const scriptPriority = Array.isArray(config.package_script_priority)
      ? config.package_script_priority
      : ["test:ci", "test:regression", "test"];
    const repoRoot = context.repoRoot;

    const manifest = this.extractManifest(context);
    if (manifest) {
      context.setVariable("test_command_manifest", manifest);
      if (Array.isArray(manifest.candidates)) {
        context.setVariable("test_command_candidates", manifest.candidates);
      }
    }

    const detection =
      this.detectFromManifest(manifest) ??
      (await this.detectFromPackageJson(repoRoot, scriptPriority)) ??
      (await this.detectFromPython(repoRoot)) ??
      (await this.detectFromCargo(repoRoot)) ??
      (await this.detectFromGo(repoRoot)) ??
      (await this.detectFromMakefile(repoRoot, config.allow_makefile ?? true));

    if (detection) {
      context.setVariable(variableName, detection.command);
      context.setVariable(`${variableName}_source`, detection.source);
      context.setVariable(`${variableName}_details`, detection.details || null);

      logger.info("TestCommandDiscoveryStep: detected test command", {
        workflowId: context.workflowId,
        command: detection.command,
        source: detection.source,
      });

      return {
        status: "success",
        data: detection,
        outputs: {
          test_command: detection.command,
          source: detection.source,
        },
      } satisfies StepResult;
    }

    context.setVariable(variableName, null);
    context.setVariable(`${variableName}_source`, null);
    context.setVariable(`${variableName}_details`, null);

    if (!requireCommand) {
      logger.warn("TestCommandDiscoveryStep: no command detected, continuing", {
        workflowId: context.workflowId,
      });

      return {
        status: "success",
        data: { test_command: null, source: null },
        outputs: { test_command: null, source: null },
      } satisfies StepResult;
    }

    const requiredFiles =
      (context.getVariable("plan_required_files") as string[] | undefined) ||
      [];
    const error = new Error(
      requiredFiles.length
        ? `TestCommandDiscoveryStep: unable to detect runnable test command. Define one (npm test, pytest, cargo test, etc.) before QA so plan files [${requiredFiles.join(", ")}] can run.`
        : "TestCommandDiscoveryStep: unable to detect runnable test command. Define an explicit test entrypoint before QA.",
    );

    return {
      status: "failure",
      error,
    } satisfies StepResult;
  }

  async validateConfig(_context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as TestCommandDiscoveryConfig;
    const errors: string[] = [];

    if (
      config.package_script_priority !== undefined &&
      !Array.isArray(config.package_script_priority)
    ) {
      errors.push(
        "TestCommandDiscoveryStep: package_script_priority must be an array",
      );
    }

    return { valid: errors.length === 0, errors, warnings: [] } satisfies ValidationResult;
  }

  private async detectFromPackageJson(
    repoRoot: string,
    priority: string[],
  ): Promise<DetectionResult | null> {
    const pkgPath = path.join(repoRoot, "package.json");
    if (!(await this.pathExists(pkgPath))) {
      return null;
    }

    try {
      const raw = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      const scripts = pkg?.scripts;
      if (!scripts || typeof scripts !== "object") {
        return null;
      }

      for (const scriptName of priority) {
        if (typeof scripts[scriptName] === "string") {
          const command = scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
          return {
            command,
            source: `package.json:scripts.${scriptName}`,
          } satisfies DetectionResult;
        }
      }

      const fallback = Object.keys(scripts).find((key) => key.includes("test"));
      if (fallback) {
        const command = fallback === "test" ? "npm test" : `npm run ${fallback}`;
        return {
          command,
          source: `package.json:scripts.${fallback}`,
        } satisfies DetectionResult;
      }
    } catch (error) {
      logger.warn("TestCommandDiscoveryStep: failed to parse package.json", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }

  private async detectFromPython(repoRoot: string): Promise<DetectionResult | null> {
    const pyproject = path.join(repoRoot, "pyproject.toml");
    if (await this.pathExists(pyproject)) {
      return { command: "pytest", source: "pyproject.toml" } satisfies DetectionResult;
    }

    const pytestIni = path.join(repoRoot, "pytest.ini");
    if (await this.pathExists(pytestIni)) {
      return { command: "pytest", source: "pytest.ini" } satisfies DetectionResult;
    }

    const toxIni = path.join(repoRoot, "tox.ini");
    if (await this.pathExists(toxIni)) {
      return { command: "tox", source: "tox.ini" } satisfies DetectionResult;
    }

    const setupCfg = path.join(repoRoot, "setup.cfg");
    if (await this.containsText(setupCfg, "pytest")) {
      return { command: "pytest", source: "setup.cfg" } satisfies DetectionResult;
    }

    return null;
  }

  private async detectFromCargo(repoRoot: string): Promise<DetectionResult | null> {
    const cargo = path.join(repoRoot, "Cargo.toml");
    if (await this.pathExists(cargo)) {
      return { command: "cargo test", source: "Cargo.toml" } satisfies DetectionResult;
    }
    return null;
  }

  private async detectFromGo(repoRoot: string): Promise<DetectionResult | null> {
    const goMod = path.join(repoRoot, "go.mod");
    if (await this.pathExists(goMod)) {
      return { command: "go test ./...", source: "go.mod" } satisfies DetectionResult;
    }
    return null;
  }

  private async detectFromMakefile(
    repoRoot: string,
    enabled: boolean,
  ): Promise<DetectionResult | null> {
    if (!enabled) {
      return null;
    }

    const makefile = path.join(repoRoot, "Makefile");
    if (!(await this.pathExists(makefile))) {
      return null;
    }

    const content = await fs.readFile(makefile, "utf-8");
    if (/^test:/m.test(content)) {
      return { command: "make test", source: "Makefile" } satisfies DetectionResult;
    }

    return null;
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  private async containsText(file: string, needle: string): Promise<boolean> {
    if (!(await this.pathExists(file))) {
      return false;
    }

    const content = await fs.readFile(file, "utf-8");
    return content.toLowerCase().includes(needle.toLowerCase());
  }

  private extractManifest(context: WorkflowContext): TestCommandManifest | null {
    const direct = context.getVariable("test_command_manifest");
    if (direct && typeof direct === "object") {
      return direct as TestCommandManifest;
    }

    const contextResult = context.getVariable("context_request_result");
    if (contextResult && typeof contextResult === "object") {
      const manifest =
        (contextResult as any).test_command_manifest ||
        (contextResult as any).test_surface;
      if (manifest && typeof manifest === "object") {
        return manifest as TestCommandManifest;
      }
    }
    return null;
  }

  private detectFromManifest(
    manifest: TestCommandManifest | null,
  ): DetectionResult | null {
    if (!manifest?.candidates || manifest.candidates.length === 0) {
      return null;
    }

    const preferred = manifest.preferred_command?.trim().toLowerCase();
    const runnable = manifest.candidates
      .filter((candidate) => this.isRunnableCandidate(candidate))
      .map((candidate) => ({
        candidate,
        score: this.scoreCandidate(candidate, preferred),
      }))
      .sort((a, b) => b.score - a.score);

    if (runnable.length === 0) {
      return null;
    }

    const best = runnable[0].candidate;
    const command = (best.command || "").trim();
    if (!command) {
      return null;
    }

    const source =
      best.source ||
      (Array.isArray(best.source_paths) && best.source_paths.length > 0
        ? best.source_paths[0]
        : "context_manifest");

    const details: Record<string, unknown> = {
      framework: best.framework || null,
      language: best.language || null,
      confidence: typeof best.confidence === "number" ? best.confidence : null,
      type: best.type || null,
      status: best.status || null,
      reason: best.reason || null,
      working_directory: best.working_directory || null,
      prerequisites: best.prerequisites || null,
      source,
    };

    return {
      command,
      source,
      details,
    } satisfies DetectionResult;
  }

  private isRunnableCandidate(candidate: TestCommandCandidate | null): boolean {
    if (!candidate || typeof candidate.command !== "string") {
      return false;
    }

    const status = (candidate.status || "").toLowerCase();
    if (status && ["blocked", "missing", "todo"].includes(status)) {
      return false;
    }

    const type = (candidate.type || "").toLowerCase();
    if (type && ["harness", "missing", "blocked"].includes(type)) {
      return false;
    }

    return candidate.command.trim().length > 0;
  }

  private scoreCandidate(
    candidate: TestCommandCandidate,
    preferred?: string,
  ): number {
    const command = candidate.command?.trim().toLowerCase();
    const confidence =
      typeof candidate.confidence === "number" ? candidate.confidence : 0.5;
    const preferredBonus = preferred && command === preferred ? 0.5 : 0;
    const readinessBonus =
      (candidate.status || "").toLowerCase() === "ready" ? 0.25 : 0;
    return confidence + preferredBonus + readinessBonus;
  }
}
