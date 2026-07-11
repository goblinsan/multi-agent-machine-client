import fs from "fs/promises";
import path from "path";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { runTestCommandWithWorker } from "../helpers/testRunner.js";
import {
  classifyValidationFailures,
  normalizeWorkflowPath,
  parseTypecheckErrors,
  summarizeScopeExpansion,
} from "./helpers/typecheckDiagnostics.js";

interface ScopeViabilityConfig {
  enabled?: boolean;
  plan_files_variable?: string;
  typecheck_command?: string;
  timeout_ms?: number;
  candidate_files?: string[];
  fail_on_scope_expansion?: boolean;
}

type ScopeViabilityDecision = {
  status: "viable" | "requires_scope_expansion" | "unknown";
  reason: string;
  editable_files: string[];
  required_files: string[];
  blocked_files: string[];
  root_cause_files: string[];
  recommendations: string[];
  repair_cluster?: {
    title: string;
    root_files: string[];
    related_task_ids: string[];
  };
};

export class ScopeViabilityStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ScopeViabilityConfig;
    if (config.enabled === false) {
      const decision = this.recordDecision(context, {
        status: "viable",
        reason: "scope_viability_disabled",
        editable_files: [],
        required_files: [],
        blocked_files: [],
        root_cause_files: [],
        recommendations: [],
      });
      return { status: "success", data: decision, outputs: decision };
    }

    const editableFiles = this.collectEditableFiles(context, config);
    const candidateFiles = await this.collectCandidateFiles(
      context.repoRoot,
      editableFiles,
      config.candidate_files || [],
    );
    const command =
      config.typecheck_command || (await this.detectTypecheckCommand(context.repoRoot));

    if (!command) {
      const decision = this.recordDecision(context, {
        status: "unknown",
        reason: "typecheck_command_not_found",
        editable_files: editableFiles,
        required_files: [],
        blocked_files: [],
        root_cause_files: [],
        recommendations: ["Proceed with implementation; no deterministic typecheck command was available."],
      });
      return { status: "success", data: decision, outputs: decision };
    }

    try {
      await runTestCommandWithWorker({
        command,
        cwd: context.repoRoot,
        timeoutMs: config.timeout_ms || 120000,
        idleTimeoutMs: 30000,
      });
      const decision = this.recordDecision(context, {
        status: "viable",
        reason: "typecheck_clean",
        editable_files: editableFiles,
        required_files: [],
        blocked_files: [],
        root_cause_files: [],
        recommendations: [],
      });
      return { status: "success", data: decision, outputs: decision };
    } catch (error: any) {
      const output =
        [error?.stdout, error?.stderr].filter(Boolean).join("\n") ||
        String(error?.message || "");
      const parsed = parseTypecheckErrors(output, context.repoRoot);
      if (parsed.length === 0) {
        const decision = this.recordDecision(context, {
          status: "unknown",
          reason: "typecheck_failed_without_parseable_diagnostics",
          editable_files: editableFiles,
          required_files: [],
          blocked_files: [],
          root_cause_files: [],
          recommendations: ["Proceed with implementation; diagnostics could not be classified deterministically."],
        });
        return { status: "success", data: decision, outputs: decision };
      }

      const scoped = classifyValidationFailures(parsed, editableFiles, {
        candidateFiles,
      });
      const expansion = summarizeScopeExpansion(scoped);
      if (expansion.requiredFiles.length > 0) {
        const recommendations = [
          "Expand the implementation plan to include the required files, or replace this task with a repair cluster that owns the shared root cause.",
        ];
        const repairCluster = this.buildRepairCluster(
          context,
          expansion.requiredFiles,
          expansion.blockedFiles,
        );
        const decision = this.recordDecision(context, {
          status: "requires_scope_expansion",
          reason: "typecheck_diagnostics_reference_out_of_scope_causal_files",
          editable_files: editableFiles,
          required_files: expansion.requiredFiles,
          blocked_files: expansion.blockedFiles,
          root_cause_files: expansion.requiredFiles,
          recommendations,
          repair_cluster: repairCluster,
        });

        if (config.fail_on_scope_expansion === false) {
          return { status: "success", data: decision, outputs: decision };
        }
        context.setVariable("workflow_stop_requested", true);
        context.setVariable("workflow_stop_reason", "requires_scope_expansion");
        return {
          status: "failure",
          error: new Error(
            `Plan scope is not viable; required out-of-scope files: ${expansion.requiredFiles.join(", ")}`,
          ),
          data: decision,
          outputs: decision,
        };
      }

      const decision = this.recordDecision(context, {
        status: "viable",
        reason: "typecheck_failures_are_within_plan_scope",
        editable_files: editableFiles,
        required_files: [],
        blocked_files: [],
        root_cause_files: [],
        recommendations: [],
      });
      return { status: "success", data: decision, outputs: decision };
    }
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as ScopeViabilityConfig;
    const errors: string[] = [];
    if (
      config.timeout_ms !== undefined &&
      (typeof config.timeout_ms !== "number" || config.timeout_ms < 1000)
    ) {
      errors.push("ScopeViabilityStep: timeout_ms must be a number >= 1000");
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  private collectEditableFiles(
    context: WorkflowContext,
    config: ScopeViabilityConfig,
  ): string[] {
    const variable = config.plan_files_variable || "plan_required_files";
    const files = [
      ...this.normalizeList(context.getVariable(variable)),
      ...this.normalizeList(context.getVariable("qa_required_files")),
    ];
    return Array.from(new Set(files)).sort();
  }

  private async collectCandidateFiles(
    repoRoot: string,
    editableFiles: string[],
    configured: string[],
  ): Promise<string[]> {
    const candidates = new Set(configured.map(normalizeWorkflowPath));
    const editable = editableFiles.map(normalizeWorkflowPath);
    for (const candidate of [
      "src/config/schema.ts",
      "src/config/loader.ts",
      "src/config/defaults.ts",
      "src/types/logEvent.ts",
      "src/types/index.ts",
    ]) {
      try {
        await fs.access(path.join(repoRoot, candidate));
        candidates.add(candidate);
      } catch {
        void 0;
      }
    }

    for (const file of editable) {
      const dir = path.posix.dirname(file);
      for (const name of [
        "schema.ts",
        "schema.tsx",
        "types.ts",
        "type.ts",
        "interfaces.ts",
        "defaults.ts",
        "loader.ts",
      ]) {
        const candidate = normalizeWorkflowPath(path.posix.join(dir, name));
        try {
          await fs.access(path.join(repoRoot, candidate));
          candidates.add(candidate);
        } catch {
          void 0;
        }
      }
    }

    return Array.from(candidates).sort();
  }

  private async detectTypecheckCommand(repoRoot: string): Promise<string | null> {
    try {
      const pkgRaw = await fs.readFile(path.join(repoRoot, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw);
      if (pkg?.scripts && typeof pkg.scripts.typecheck === "string") {
        return "npm run typecheck";
      }
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

  private normalizeList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) =>
        typeof entry === "string" ? normalizeWorkflowPath(entry) : "",
      )
      .filter((entry) => entry.length > 0);
  }

  private recordDecision(
    context: WorkflowContext,
    decision: ScopeViabilityDecision,
  ): ScopeViabilityDecision {
    context.setVariable("scope_viability", decision);
    context.setVariable("scope_viability_status", decision.status);
    context.setVariable("scope_viability_required_files", decision.required_files);
    context.setVariable("scope_viability_blocked_files", decision.blocked_files);
    context.setVariable(
      "scope_viability_root_cause_files",
      decision.root_cause_files,
    );
    if (decision.repair_cluster) {
      context.setVariable("scope_viability_repair_cluster", decision.repair_cluster);
    }
    return decision;
  }

  private buildRepairCluster(
    context: WorkflowContext,
    requiredFiles: string[],
    blockedFiles: string[],
  ): ScopeViabilityDecision["repair_cluster"] {
    const roots = Array.from(new Set(requiredFiles.map(normalizeWorkflowPath))).sort();
    if (roots.length === 0) return undefined;
    const tasks = this.normalizeTasks(context.getVariable("review_existing_tasks"));
    const terms = [...roots, ...blockedFiles.map(normalizeWorkflowPath)];
    const related = tasks
      .filter((task) => {
        const text = [
          task.title,
          task.name,
          task.description,
          task.details,
          Array.isArray(task.labels) ? task.labels.join(" ") : "",
        ]
          .filter((value) => typeof value === "string")
          .join("\n")
          .toLowerCase();
        return terms.some((term) => term && text.includes(term.toLowerCase()));
      })
      .map((task) => String(task.id || task.task_id || ""))
      .filter(Boolean);

    return {
      title: `Repair shared scope for ${roots.join(", ")}`,
      root_files: roots,
      related_task_ids: Array.from(new Set(related)).sort(),
    };
  }

  private normalizeTasks(value: unknown): any[] {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const maybeTasks = (value as any).tasks || (value as any).items;
      if (Array.isArray(maybeTasks)) return maybeTasks;
    }
    return [];
  }
}
