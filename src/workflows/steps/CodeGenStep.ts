import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { callLMStudio, ChatMessage } from "../../lmstudio.js";
import { TaskData } from "./PullTaskStep.js";

export interface CodeGenConfig {
  persona: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retryCount?: number;
  includeContext?: boolean;
  promptTemplate?: string;
}

export interface CodeGenResult {
  response: string;
  diffs: any[];
  metadata: {
    persona: string;
    model: string;
    tokens: number;
    duration_ms: number;
    temperature: number;
    generatedAt: number;
  };
}

export class CodeGenStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as CodeGenConfig;
    const {
      persona,
      model,
      temperature = 0.7,
      maxTokens = 4000,
      timeoutMs = 120000,
      retryCount = 2,
      includeContext = true,
      promptTemplate,
    } = config;

    logger.info(`Generating code with persona: ${persona}`, {
      model,
      temperature,
      maxTokens,
      includeContext,
    });

    try {
      const task = context.getVariable("task") as TaskData;
      if (!task) {
        throw new Error("No task data found in context");
      }

      let contextData = null;
      if (includeContext) {
        contextData = context.getVariable("context");
        if (!contextData) {
          logger.warn(
            "Context requested but not found, continuing without context",
          );
        }
      }

      let prompt = promptTemplate || this.buildDefaultPrompt(task, contextData);

      if (contextData && contextData.repoScan) {
        const fileList = contextData.repoScan
          .slice(0, 50)
          .map((file: any) => `${file.path} (${file.bytes} bytes)`)
          .join("\n");

        prompt += `\n\nRepository Structure:\n${fileList}`;

        if (contextData.repoScan.length > 50) {
          prompt += `\n... and ${contextData.repoScan.length - 50} more files`;
        }
      }

      logger.debug("Generated prompt for code generation", {
        promptLength: prompt.length,
        persona,
        taskType: task.type,
      });

      const startTime = Date.now();

      let lastError: Error | null = null;
      let response: string | null = null;

      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          const messages: ChatMessage[] = [
            {
              role: "system",
              content: `You are a ${persona} persona. Generate code according to the task requirements.`,
            },
            {
              role: "user",
              content: prompt,
            },
          ];

          const llmResponse = await callLMStudio(
            model || "default",
            messages,
            temperature,
            { timeoutMs, retries: 0 },
          );

          response = llmResponse.content;
          break;
        } catch (error: any) {
          lastError = error;
          logger.warn(`Code generation attempt ${attempt + 1} failed`, {
            error: error.message,
            persona,
            attempt: attempt + 1,
            maxAttempts: retryCount + 1,
          });

          if (attempt < retryCount) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (!response) {
        throw (
          lastError || new Error("Code generation failed after all retries")
        );
      }

      const duration_ms = Date.now() - startTime;

      const diffs = this.parseDiffBlocks(response);

      const result: CodeGenResult = {
        response,
        diffs,
        metadata: {
          persona,
          model: model || "default",
          tokens: response.length,
          duration_ms,
          temperature,
          generatedAt: Date.now(),
        },
      };

      context.setVariable("codeGenResult", result);
      context.setVariable("response", response);
      context.setVariable("diffs", diffs);

      logger.info("Code generation completed successfully", {
        persona,
        responseLength: response.length,
        diffCount: diffs.length,
        duration_ms,
      });

      return {
        status: "success",
        data: result,
        outputs: {
          codeGenResult: result,
          response,
          diffs,
        },
        metrics: {
          duration_ms,
          operations_count: diffs.length,
        },
      };
    } catch (error: any) {
      logger.error("Code generation failed", {
        error: error.message,
        persona,
        step: this.config.name,
      });

      return {
        status: "failure",
        error: new Error(`Code generation failed: ${error.message}`),
      };
    }
  }

  private buildDefaultPrompt(task: TaskData, _contextData: any): string {
    let prompt = `Task: ${task.type}\n`;
    prompt += `Persona: ${task.persona}\n`;

    if (task.data.description) {
      prompt += `Description: ${task.data.description}\n`;
    }

    if (task.data.requirements) {
      prompt += `Requirements:\n${JSON.stringify(task.data.requirements, null, 2)}\n`;
    }

    prompt +=
      "\nPlease generate the necessary code changes to complete this task.";
    prompt +=
      "\nProvide your response with clear diff blocks using the following format:";
    prompt +=
      "\n```diff\n--- a/path/to/file\n+++ b/path/to/file\n@@ line changes @@\n code diff here\n```";

    return prompt;
  }

  private parseDiffBlocks(response: string): any[] {
    const diffBlocks = [];
    const diffRegex = /```diff\n([\s\S]*?)\n```/g;
    let match;

    while ((match = diffRegex.exec(response)) !== null) {
      const diffContent = match[1].trim();
      if (diffContent) {
        diffBlocks.push({
          raw: diffContent,
          parsed: this.parseSingleDiff(diffContent),
        });
      }
    }

    return diffBlocks;
  }

  private parseSingleDiff(diffContent: string): any {
    const lines = diffContent.split("\n");
    let filePath = "";

    for (const line of lines) {
      if (line.startsWith("--- a/") || line.startsWith("+++ b/")) {
        filePath = line.substring(6);
        break;
      }
    }

    return {
      filePath,
      content: diffContent,
      lines: lines.length,
    };
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as any;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.persona || typeof config.persona !== "string") {
      errors.push("CodeGenStep: persona is required and must be a string");
    }

    if (config.model !== undefined && typeof config.model !== "string") {
      errors.push("CodeGenStep: model must be a string");
    }

    if (
      config.temperature !== undefined &&
      (typeof config.temperature !== "number" ||
        config.temperature < 0 ||
        config.temperature > 2)
    ) {
      errors.push("CodeGenStep: temperature must be a number between 0 and 2");
    }

    if (
      config.maxTokens !== undefined &&
      (typeof config.maxTokens !== "number" || config.maxTokens < 1)
    ) {
      errors.push("CodeGenStep: maxTokens must be a positive number");
    }

    if (
      config.timeoutMs !== undefined &&
      (typeof config.timeoutMs !== "number" || config.timeoutMs < 1000)
    ) {
      errors.push("CodeGenStep: timeoutMs must be a number >= 1000");
    }

    if (
      config.retryCount !== undefined &&
      (typeof config.retryCount !== "number" || config.retryCount < 0)
    ) {
      errors.push("CodeGenStep: retryCount must be a non-negative number");
    }

    if (
      config.includeContext !== undefined &&
      typeof config.includeContext !== "boolean"
    ) {
      errors.push("CodeGenStep: includeContext must be a boolean");
    }

    if (
      config.promptTemplate !== undefined &&
      typeof config.promptTemplate !== "string"
    ) {
      errors.push("CodeGenStep: promptTemplate must be a string");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async cleanup(context: WorkflowContext): Promise<void> {
    const result = context.getVariable("codeGenResult");
    if (result) {
      logger.debug("Cleaning up code generation result");
    }
  }
}
