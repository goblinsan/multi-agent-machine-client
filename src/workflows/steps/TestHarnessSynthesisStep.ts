import fs from "fs/promises";
import path from "path";

import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { TaskPriority } from "./helpers/TaskPriorityCalculator.js";
import { TestCommandManifest } from "./helpers/TestCommandManifest.js";

interface TestHarnessSynthesisConfig {
  detection_variable?: string;
  repo_root?: string;
  labels?: string[];
}

interface HarnessPlan {
  language: string;
  framework: string;
  command: string;
  priority: TaskPriority;
  dependencies: string[];
  steps: string[];
  title: string;
  summary: string;
  rationale?: string;
  labels?: string[];
  source?: string;
}

interface SynthesizedTask {
  title: string;
  description: string;
  priority: TaskPriority;
  metadata?: Record<string, unknown>;
  milestone_slug?: string;
  external_id?: string;
}

export class TestHarnessSynthesisStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = (this.config.config || {}) as TestHarnessSynthesisConfig;
    const detectionVariable = config.detection_variable || "detected_test_command";
    const detectedCommand = context.getVariable(detectionVariable);

    if (detectedCommand) {
      return {
        status: "success",
        outputs: {
          harness_required: false,
          harness_plan: null,
          harness_tasks: [],
        },
        data: {
          harness_required: false,
          plan: null,
          tasks: [],
        },
      } satisfies StepResult;
    }

    const repoRoot =
      config.repo_root || context.repoRoot || context.getVariable("repo_root");
    const manifest = this.getManifest(context);
    if (manifest) {
      context.setVariable("test_command_manifest", manifest);
    }

    const plan =
      this.extractPlanFromManifest(manifest) ||
      (await this.detectFallbackPlan(repoRoot));
    const baseLabels = [
      "qa-gap",
      "missing-tests",
      "test-harness",
      `language:${plan.language}`,
    ];
    const labelsWithPlan = this.mergeLabels(baseLabels, plan.labels);
    const labels = this.mergeLabels(labelsWithPlan, config.labels);
    const milestoneSlug = this.resolveMilestoneSlug(context);
    const description = this.buildDescription(plan);

    const tasks: SynthesizedTask[] = [
      {
        title: plan.title,
        description,
        priority: plan.priority,
        metadata: {
          labels,
          reason: plan.rationale || "missing_test_command",
          recommended_command: plan.command,
          recommended_framework: plan.framework,
          dependencies: plan.dependencies,
          plan_source: plan.source || "detector",
        },
        milestone_slug: milestoneSlug,
        external_id: `${context.workflowId}:test-harness`,
      },
    ];

    context.setVariable("test_harness_required", true);
    context.setVariable("test_harness_plan", plan);
    context.setVariable("test_harness_tasks", tasks);
    context.setVariable("test_harness_plan_source", plan.source || "detector");

    context.logger.warn("Test harness synthesis triggered", {
      stepName: this.config.name,
      repoRoot,
      plan,
    });

    return {
      status: "success",
      outputs: {
        harness_required: true,
        harness_plan: plan,
        harness_tasks: tasks,
      },
      data: {
        harness_required: true,
        plan,
        tasks,
      },
    } satisfies StepResult;
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] } satisfies ValidationResult;
  }

  private async detectFallbackPlan(repoRoot?: string): Promise<HarnessPlan> {
    if (repoRoot && (await this.pathExists(path.join(repoRoot, "package.json")))) {
      const packageManager = await this.detectPackageManager(repoRoot);
      const command = this.resolveCommand(packageManager);
      return {
        language: "javascript",
        framework: "Vitest",
        command,
        priority: "critical",
        dependencies: ["vitest"],
        title: "Bootstrap Vitest harness and npm test script",
        summary:
          "Add a deterministic Vitest harness so QA and CI can execute \"" +
          `${command}` +
          "\" before reviews.",
        steps: [
          `Install Vitest (and @types/node for TypeScript) via ${packageManager} add -D vitest @types/node`,
          "Add a vitest.config.(ts|js) with jsdom/node test environment that matches the app",
          "Create at least one smoke test under src or tests to prove the harness runs",
           `Add a "test" script to package.json that invokes ${command
             .replace(/^[^\s]+\s/, "")
             .trim() || "vitest run"}`,
          "Ensure CI runs the same command and fails on non-zero exit codes",
        ],
        source: "fallback:package.json",
      } satisfies HarnessPlan;
    }

    if (repoRoot && (await this.pathExists(path.join(repoRoot, "pyproject.toml")))) {
      return {
        language: "python",
        framework: "pytest",
        command: "pytest",
        priority: "critical",
        dependencies: ["pytest"],
        title: "Establish pytest harness and CI command",
        summary: "Wire up pytest so \"pytest\" passes locally and in CI.",
        steps: [
          "Add pytest to the dev dependencies in pyproject.toml",
          "Create tests/ directory with at least one smoke test",
          "Ensure pytest.ini or pyproject config sets the pythonpath and markers",
          "Document how to run pytest locally and ensure CI executes the same command",
        ],
        source: "fallback:pyproject",
      } satisfies HarnessPlan;
    }

    if (repoRoot && (await this.pathExists(path.join(repoRoot, "go.mod")))) {
      return {
        language: "go",
        framework: "go test",
        command: "go test ./...",
        priority: "high",
        dependencies: [],
        title: "Ensure go test ./... succeeds",
        summary: "Add Go test files and wire a go test command for CI.",
        steps: [
          "Add *_test.go files that cover the primary package",
          "Document go test ./... in README or CONTRIBUTING",
          "Ensure go.mod/go.sum include any new dependencies",
        ],
        source: "fallback:go",
      } satisfies HarnessPlan;
    }

    if (repoRoot && (await this.pathExists(path.join(repoRoot, "Cargo.toml")))) {
      return {
        language: "rust",
        framework: "cargo test",
        command: "cargo test",
        priority: "high",
        dependencies: [],
        title: "Restore cargo test harness",
        summary: "Ensure cargo test runs successfully with representative coverage.",
        steps: [
          "Add integration tests under tests/ or unit tests inline",
          "Update Cargo.toml with required dev-dependencies",
          "Document cargo test expectations for contributors",
        ],
        source: "fallback:cargo",
      } satisfies HarnessPlan;
    }

    return {
      language: "general",
      framework: "Custom",
      command: "tests",
      priority: "high",
      dependencies: [],
      title: "Add deterministic test harness",
      summary:
        "Define a repeatable test command so QA can validate future changes (framework TBD).",
      steps: [
        "Select a framework consistent with the language and document why",
        "Add at least one smoke test to prove the harness works",
        "Expose a single command (npm test, make test, etc.) that CI can call",
      ],
      source: "fallback:general",
    } satisfies HarnessPlan;
  }

  private getManifest(context: WorkflowContext): TestCommandManifest | null {
    const manifestVar = context.getVariable("test_command_manifest");
    if (manifestVar && typeof manifestVar === "object") {
      return manifestVar as TestCommandManifest;
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

  private extractPlanFromManifest(
    manifest: TestCommandManifest | null,
  ): HarnessPlan | null {
    const suggestion = manifest?.harness_plan;
    if (!suggestion) {
      return null;
    }

    const command = suggestion.command?.trim() || "tests";
    const language = suggestion.language || "general";
    const framework = suggestion.framework || "Custom";
    const title = suggestion.title || `Add ${framework} harness (${language.toUpperCase()})`;
    const summary =
      suggestion.summary ||
      suggestion.rationale ||
      "Add a deterministic harness so QA can execute the recommended command before reviews.";
    const steps = Array.isArray(suggestion.steps) && suggestion.steps.length > 0
      ? suggestion.steps
      : [
          `Document how to run ${command} locally and in CI`,
          "Add at least one smoke test proving the harness executes",
          "Publish the command in README and CI scripts",
        ];
    const dependencies = Array.isArray(suggestion.dependencies)
      ? suggestion.dependencies
      : [];
    const priority = this.normalizePriority(suggestion.priority);

    return {
      language,
      framework,
      command,
      priority,
      dependencies,
      steps,
      title,
      summary,
      rationale: suggestion.rationale,
      labels: suggestion.labels,
      source: suggestion.source || "context_manifest",
    } satisfies HarnessPlan;
  }

  private normalizePriority(priority?: TaskPriority): TaskPriority {
    if (!priority) {
      return "high";
    }
    const allowed: TaskPriority[] = ["critical", "high", "medium", "low"];
    return allowed.includes(priority) ? priority : "high";
  }

  private async detectPackageManager(repoRoot: string): Promise<string> {
    const lockFiles = [
      { file: "pnpm-lock.yaml", manager: "pnpm" },
      { file: "yarn.lock", manager: "yarn" },
      { file: "bun.lockb", manager: "bun" },
      { file: "package-lock.json", manager: "npm" },
    ];

    for (const lock of lockFiles) {
      if (await this.pathExists(path.join(repoRoot, lock.file))) {
        return lock.manager;
      }
    }

    return "npm";
  }

  private resolveCommand(packageManager: string): string {
    switch (packageManager) {
      case "pnpm":
        return "pnpm test";
      case "yarn":
        return "yarn test";
      case "bun":
        return "bun test";
      default:
        return "npm test";
    }
  }

  private buildDescription(plan: HarnessPlan): string {
    const header =
      `The workflow could not find a runnable test command. Establish ${plan.framework} so reviews can gate on real tests.`;
    const summary = plan.summary;
    const steps = ["Acceptance criteria:", ...plan.steps.map((step, index) => `${index + 1}. ${step}`)];
    const verification = [
      "Verification:",
      `- Running ${plan.command} locally succeeds and exits 0.`,
      "- The same command runs inside CI before QA/code reviews.",
      "- Include instructions in README or CONTRIBUTING so future tasks reuse the harness.",
    ];
    return [header, summary, ...steps, ...verification].join("\n\n");
  }

  private mergeLabels(base: string[], extra?: string[]): string[] {
    const merged = new Set<string>(base.filter(Boolean));
    (extra || []).forEach((label) => {
      if (label) {
        merged.add(label);
      }
    });
    return Array.from(merged);
  }

  private resolveMilestoneSlug(context: WorkflowContext): string | undefined {
    const milestone = context.getVariable("milestone");
    if (milestone?.slug) {
      return milestone.slug;
    }

    const task = context.getVariable("task");
    if (task?.milestone?.slug) {
      return task.milestone.slug;
    }

    return undefined;
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }
}
