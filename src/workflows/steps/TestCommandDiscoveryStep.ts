import fs from "fs/promises";
import path from "path";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";

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

    const detection =
      (await this.detectFromPackageJson(repoRoot, scriptPriority)) ??
      (await this.detectFromPython(repoRoot)) ??
      (await this.detectFromCargo(repoRoot)) ??
      (await this.detectFromGo(repoRoot)) ??
      (await this.detectFromMakefile(repoRoot, config.allow_makefile ?? true));

    if (detection) {
      context.setVariable(variableName, detection.command);
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

    if (!requireCommand) {
      context.setVariable(variableName, null);
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
}
