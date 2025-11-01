import type { WorkflowStep, WorkflowStepConfig } from "./WorkflowStep";
import type { WorkflowContext } from "./WorkflowContext";
import type {
  WorkflowDefinition,
  WorkflowStepDefinition,
} from "../WorkflowEngine";
import { ConfigResolver } from "./ConfigResolver";
import { templateLoader } from "./TemplateLoader.js";
import { personaTimeoutMs } from "../../util.js";
import { cfg } from "../../config.js";
import { logger } from "../../logger.js";

interface ExtendedStepDefinition extends WorkflowStepDefinition {
  template?: string;
  overrides?: Partial<WorkflowStepConfig>;
}

export class StepExecutor {
  private stepRegistry: Map<string, new (...args: any[]) => WorkflowStep>;
  private configResolver: ConfigResolver;

  constructor(stepRegistry: Map<string, new (...args: any[]) => WorkflowStep>) {
    this.stepRegistry = stepRegistry;
    this.configResolver = new ConfigResolver();
  }

  async executeStep(
    stepDef: WorkflowStepDefinition,
    context: WorkflowContext,
    workflowDef: WorkflowDefinition,
  ): Promise<boolean> {
    try {
      const step = this.createStepInstance(stepDef, context);

      context.recordStepStart(stepDef.name);

      const timeout = this.getStepTimeout(stepDef, workflowDef);

      if (stepDef.type === "PersonaRequestStep") {
        context.logger.info("Step timeout configured", {
          workflowId: context.workflowId,
          step: stepDef.name,
          persona: stepDef.config.persona,
          timeoutMs: timeout,
          timeoutMinutes: (timeout / 60000).toFixed(2),
        });
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(`Step '${stepDef.name}' timed out after ${timeout}ms`),
            ),
          timeout,
        );
      });

      const stepPromise = step.execute(context);
      const result = await Promise.race([stepPromise, timeoutPromise]);

      if (result.outputs) {
        context.setStepOutput(stepDef.name, result.outputs);
      } else if (result.data) {
        context.setStepOutput(stepDef.name, result.data);
      }

      context.recordStepComplete(
        stepDef.name,
        result.status === "success" ? "success" : "failure",
      );

      return result.status === "success";
    } catch (error: any) {
      context.recordStepComplete(stepDef.name, "failure", error.message);
      throw error;
    }
  }

  private createStepInstance(
    stepDef: WorkflowStepDefinition,
    context: WorkflowContext,
  ): WorkflowStep {
    const extendedDef = stepDef as ExtendedStepDefinition;

    let finalStepConfig: WorkflowStepConfig;

    if (extendedDef.template) {
      const expanded = templateLoader.expandTemplate(
        extendedDef.template,
        stepDef.name,
        extendedDef.overrides,
      );

      finalStepConfig = {
        ...expanded,
        depends_on: stepDef.depends_on,
        condition: stepDef.condition,
      };
    } else {
      finalStepConfig = {
        name: stepDef.name,
        type: stepDef.type || "undefined",
        description: stepDef.description,
        depends_on: stepDef.depends_on,
        condition: stepDef.condition,
        config: stepDef.config,
        outputs: stepDef.outputs,
      };
    }

    const StepClass = this.stepRegistry.get(finalStepConfig.type);
    if (!StepClass) {
      throw new Error(
        `Unknown step type '${finalStepConfig.type}' in step '${stepDef.name}'`,
      );
    }

    const resolvedConfig = this.configResolver.resolveConfiguration(
      finalStepConfig.config || {},
      context,
    );
    finalStepConfig.config = resolvedConfig;

    return new StepClass(finalStepConfig);
  }

  private getStepTimeout(
    stepDef: WorkflowStepDefinition,
    workflowDef: WorkflowDefinition,
  ): number {
    const timeouts = workflowDef.timeouts || {};

    const stepTimeout =
      timeouts[`${stepDef.name}_timeout`] ||
      timeouts[`${stepDef.type.toLowerCase()}_step`];
    if (stepTimeout) {
      return stepTimeout;
    }

    if (stepDef.type === "PersonaRequestStep" && stepDef.config.persona) {
      const persona = String(stepDef.config.persona).toLowerCase();
      const maxRetries =
        stepDef.config.maxRetries ?? cfg.personaTimeoutMaxRetries ?? 3;

      const personaTimeout = personaTimeoutMs(persona, cfg);

      const totalBackoffMs =
        maxRetries > 0 ? (30 * 1000 * maxRetries * (maxRetries + 1)) / 2 : 0;
      const totalPersonaTimeMs = (maxRetries + 1) * personaTimeout;
      const calculatedTimeout = totalPersonaTimeMs + totalBackoffMs + 30000;

      logger.info(
        "Calculated PersonaRequestStep timeout to accommodate retries",
        {
          step: stepDef.name,
          persona,
          personaTimeoutMs: personaTimeout,
          personaTimeoutMinutes: (personaTimeout / 60000).toFixed(2),
          maxRetries,
          totalBackoffMs,
          totalBackoffMinutes: (totalBackoffMs / 60000).toFixed(2),
          totalPersonaTimeMs,
          calculatedTimeout,
          calculatedTimeoutMinutes: (calculatedTimeout / 60000).toFixed(2),
        },
      );

      return calculatedTimeout;
    }

    return timeouts.default_step || 300000;
  }

  buildExecutionOrder(steps: WorkflowStepDefinition[]): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (stepName: string) => {
      if (visiting.has(stepName)) {
        throw new Error(
          `Circular dependency detected involving step: ${stepName}`,
        );
      }

      if (visited.has(stepName)) {
        return;
      }

      visiting.add(stepName);

      const step = steps.find((s) => s.name === stepName);
      if (!step) {
        throw new Error(`Step not found: ${stepName}`);
      }

      if (step.depends_on) {
        for (const dependency of step.depends_on) {
          visit(dependency);
        }
      }

      visiting.delete(stepName);
      visited.add(stepName);
      order.push(stepName);
    };

    for (const step of steps) {
      visit(step.name);
    }

    return order;
  }
}
