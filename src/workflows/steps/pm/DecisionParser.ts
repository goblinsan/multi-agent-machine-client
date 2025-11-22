import { logger } from "../../../logger.js";

export interface PMDecision {
  decision: "immediate_fix" | "defer";
  reasoning: string;
  detected_stage?: "early" | "beta" | "production";
  immediate_issues: string[];
  deferred_issues: string[];
  follow_up_tasks: Array<{
    title: string;
    description: string;
    priority: "critical" | "high" | "medium" | "low";
    milestone_id?: number | string;
    milestone_slug?: string;
    milestone_name?: string;
    metadata?: Record<string, any>;
  }>;
  backlog?: Array<{
    title: string;
    description: string;
    priority: "critical" | "high" | "medium" | "low";
    milestone_id?: number | string;
    milestone_slug?: string;
    milestone_name?: string;
    metadata?: Record<string, any>;
  }>;
}

export class DecisionParser {
  parseFromString(
    input: string,
    reviewType?: string,
    warnings?: string[],
    allowRawFallback = true,
  ): PMDecision {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed === "object" && parsed !== null) {
        return this.parseFromObject(
          parsed,
          reviewType,
          warnings,
          allowRawFallback,
        );
      }
    } catch (e) {
      logger.debug("Failed to parse PM decision as JSON", { error: String(e) });
    }

    try {
      const codeBlockMatch = input.match(/```json([\s\S]*?)```/i);
      if (codeBlockMatch) {
        const jsonText = codeBlockMatch[1].trim();
        const parsed = JSON.parse(jsonText);
        if (typeof parsed === "object" && parsed !== null) {
          return this.parseFromObject(
            parsed,
            reviewType,
            warnings,
            allowRawFallback,
          );
        }
      }
    } catch (e) {
      logger.debug("Failed to extract and parse JSON from text", {
        error: String(e),
      });
    }

    const decision: PMDecision = {
      decision: input.toLowerCase().includes("defer")
        ? "defer"
        : "immediate_fix",
      reasoning: "",
      immediate_issues: [],
      deferred_issues: [],
      follow_up_tasks: [],
    };

    const reasoningMatch = input.match(/reasoning[:\s]+([^\n]+)/i);
    if (reasoningMatch) {
      decision.reasoning = reasoningMatch[1].trim();
    }

    const immediateMatch = input.match(
      /immediate[_\s]issues?[:\s]+\[(.*?)\]/is,
    );
    if (immediateMatch) {
      decision.immediate_issues = this.parseArrayString(immediateMatch[1]);
    }

    const deferredMatch = input.match(/deferred[_\s]issues?[:\s]+\[(.*?)\]/is);
    if (deferredMatch) {
      decision.deferred_issues = this.parseArrayString(deferredMatch[1]);
    }

    const tasksMatch = input.match(/follow[_\s]up[_\s]tasks?[:\s]+\[(.*?)\]/is);
    if (tasksMatch) {
      decision.follow_up_tasks = this.parseTasksArray(tasksMatch[1]);
    }

    return decision;
  }

  parseFromObject(
    input: any,
    reviewType?: string,
    warnings?: string[],
    allowRawFallback = true,
  ): PMDecision {
    if (input && typeof input === "object") {
      const fallbackFields = ["raw", "text", "content", "message"];
      for (const field of fallbackFields) {
        const candidate = input[field];
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          const parsed = this.parseFromString(
            candidate,
            reviewType,
            warnings,
            false,
          );
          if (this.hasMeaningfulData(parsed)) {
            return parsed;
          }
        }
      }
    }

    let decisionObj = input;
    if (input.pm_decision) {
      decisionObj = input.pm_decision;
    } else if (input.decision_object) {
      decisionObj = input.decision_object;
    } else if (input.json && typeof input.json === "object") {
      decisionObj = input.json;
    }

    const unwrapKeys = ["output", "data", "result", "response"];
    let unwrapDepth = 0;

    const tryParseStringPayload = (payload: string, origin: string) => {
      const parsedDecision = this.parseFromString(
        payload,
        reviewType,
        warnings,
        false,
      );
      if (this.hasMeaningfulData(parsedDecision)) {
        logger.info("Parsed PM decision from string payload", {
          reviewType,
          origin,
        });
        return parsedDecision;
      }

      try {
        const parsedJson = JSON.parse(payload);
        if (parsedJson && typeof parsedJson === "object") {
          return parsedJson;
        }
      } catch (error) {
        logger.debug("Failed to parse decision JSON string", {
          reviewType,
          error: String(error),
          origin,
        });
      }

      return null;
    };

    while (
      decisionObj &&
      typeof decisionObj === "object" &&
      unwrapDepth < 4
    ) {
      let unwrapped = false;
      for (const key of unwrapKeys) {
        if (!(key in decisionObj)) {
          continue;
        }

        const candidate = decisionObj[key];
        if (typeof candidate === "string") {
          const parsed = tryParseStringPayload(candidate, key);
          if (parsed) {
            if (this.isPMDecision(parsed)) {
              return parsed;
            }
            decisionObj = parsed;
            unwrapped = true;
            break;
          }
        }

        if (candidate && typeof candidate === "object") {
          decisionObj = candidate;
          unwrapped = true;
          break;
        }
      }

      if (!unwrapped) {
        break;
      }

      unwrapDepth += 1;
    }

    if (typeof decisionObj === "string") {
      const parsed = tryParseStringPayload(decisionObj, "root");
      if (parsed) {
        if (this.isPMDecision(parsed)) {
          return parsed;
        }
        decisionObj = parsed;
      }
    }

    let followUpTasks: any[] = [];
    let followUpSource: string | null = null;
    const followUpCandidates: Array<{ value: any; source: string }> = [
      { value: decisionObj.follow_up_tasks, source: "follow_up_tasks" },
      { value: decisionObj.followUpTasks, source: "followUpTasks" },
      { value: decisionObj.followupTasks, source: "followupTasks" },
      { value: decisionObj.followUp, source: "followUp" },
      { value: decisionObj.follow_up, source: "follow_up" },
      { value: decisionObj.tasks, source: "tasks" },
    ];

    for (const { value, source } of followUpCandidates) {
      if (Array.isArray(value) && value.length > 0) {
        followUpTasks = value;
        followUpSource = source;
        logger.info("Using follow-up tasks from candidate", {
          reviewType,
          source,
          count: followUpTasks.length,
        });
        break;
      }

      if (typeof value === "string" && value.trim().length > 0) {
        try {
          const parsedCandidate = JSON.parse(value);
          if (Array.isArray(parsedCandidate) && parsedCandidate.length > 0) {
            followUpTasks = parsedCandidate;
            followUpSource = `${source}:json_string`;
            logger.info("Parsed follow-up tasks from string candidate", {
              reviewType,
              source,
              count: followUpTasks.length,
            });
            break;
          }
        } catch (error) {
          logger.debug("Failed to parse string follow_up_tasks payload", {
            reviewType,
            error: String(error),
            source,
          });
        }
      }
    }

    if (
      followUpTasks.length === 0 &&
      Array.isArray(decisionObj.milestone_updates)
    ) {
      const promoted = decisionObj.milestone_updates
        .filter((update: any) => update && typeof update === "object")
        .map((update: any) => ({
          title: update.title || update.name || "",
          description:
            update.description || update.details || update.summary || "",
          priority: this.normalizePriority(update.priority ?? "medium"),
        }))
        .filter((task: any) =>
          [task.title, task.description].some((value) =>
            typeof value === "string" && value.trim().length > 0,
          ),
        );

      if (promoted.length > 0) {
        followUpTasks = promoted;
        followUpSource = "milestone_updates";
        if (warnings) {
          warnings.push(
            "PM response missing follow_up_tasks - promoted milestone_updates",
          );
        }
        logger.info("Promoted milestone_updates to follow-up tasks", {
          reviewType,
          count: followUpTasks.length,
        });
      }
    }

    if (Array.isArray(decisionObj.backlog)) {
      const msg =
        'PM returned deprecated "backlog" field - merging into follow_up_tasks';
      logger.warn(msg, {
        backlogCount: decisionObj.backlog.length,
        followUpTasksCount: followUpTasks.length,
        reviewType,
      });
      if (warnings) warnings.push('PM used deprecated "backlog" field');

      followUpTasks = [...followUpTasks, ...decisionObj.backlog];

      if (Array.isArray(decisionObj.follow_up_tasks) && warnings) {
        warnings.push('PM returned both "backlog" and "follow_up_tasks"');
      }
    }

    const decision: PMDecision = {
      decision:
        decisionObj.status && /immediate_fix/i.test(String(decisionObj.status))
          ? "immediate_fix"
          : decisionObj.immediate_fix === true
            ? "immediate_fix"
            : decisionObj.immediate_fix === false
              ? "defer"
              : decisionObj.decision === "defer"
                ? "defer"
                : "immediate_fix",
      reasoning: decisionObj.reasoning || decisionObj.explanation || "",
      immediate_issues: Array.isArray(decisionObj.immediate_issues)
        ? decisionObj.immediate_issues
        : [],
      deferred_issues: Array.isArray(decisionObj.deferred_issues)
        ? decisionObj.deferred_issues
        : [],
      follow_up_tasks: followUpTasks.map((task: any) => ({
        title: task.title || "",
        description: task.description || "",
        priority: this.normalizePriority(task.priority),
      })),
    };

    if (decisionObj.detected_stage) {
      decision.detected_stage = decisionObj.detected_stage;
    }

    if (
      allowRawFallback &&
      Array.isArray(decision.follow_up_tasks) &&
      decision.follow_up_tasks.length === 0 &&
      input &&
      typeof input === "object"
    ) {
      const fallbackFields = ["raw", "text", "content", "message"];
      for (const field of fallbackFields) {
        const candidate = input[field];
        if (typeof candidate !== "string" || candidate.trim().length === 0) {
          continue;
        }

        const parsedFromRaw = this.parseFromString(
          candidate,
          reviewType,
          warnings,
          false,
        );

        if (parsedFromRaw.follow_up_tasks.length > 0) {
          decision.follow_up_tasks = parsedFromRaw.follow_up_tasks;
          followUpSource = `fallback:${field}`;
          logger.info("Recovered follow-up tasks from fallback field", {
            reviewType,
            field,
            count: decision.follow_up_tasks.length,
          });
        }

        if (
          (!decision.reasoning || decision.reasoning.trim().length === 0) &&
          parsedFromRaw.reasoning
        ) {
          decision.reasoning = parsedFromRaw.reasoning;
        }

        if (
          decision.immediate_issues.length === 0 &&
          parsedFromRaw.immediate_issues.length > 0
        ) {
          decision.immediate_issues = parsedFromRaw.immediate_issues;
        }

        if (
          decision.deferred_issues.length === 0 &&
          parsedFromRaw.deferred_issues.length > 0
        ) {
          decision.deferred_issues = parsedFromRaw.deferred_issues;
        }

        if (decision.follow_up_tasks.length > 0) {
          break;
        }
      }
    }

    if (followUpSource) {
      logger.info("Final follow-up task source", {
        reviewType,
        source: followUpSource,
        count: decision.follow_up_tasks.length,
      });
    } else {
      const fallbackFieldPresence =
        input && typeof input === "object"
          ? ["raw", "text", "content", "message"].filter((key) => {
              const candidate = input[key];
              return typeof candidate === "string" && candidate.length > 0;
            })
          : null;
      logger.info("No follow-up tasks extracted", {
        reviewType,
        hasMilestoneUpdates: Array.isArray(decisionObj.milestone_updates)
          ? decisionObj.milestone_updates.length
          : null,
        hasRawFallback: fallbackFieldPresence,
      });
    }

    return decision;
  }

  private hasMeaningfulData(decision: PMDecision): boolean {
    return (
      decision.follow_up_tasks.length > 0 ||
      decision.immediate_issues.length > 0 ||
      decision.deferred_issues.length > 0 ||
      (decision.reasoning && decision.reasoning.trim().length > 0) ||
      decision.decision === "defer"
    );
  }

  private isPMDecision(value: any): value is PMDecision {
    return (
      value &&
      typeof value === "object" &&
      Array.isArray((value as any).follow_up_tasks) &&
      typeof (value as any).decision === "string"
    );
  }

  private parseArrayString(str: string): string[] {
    const items: string[] = [];
    const matches = str.matchAll(/"([^"]*)"/g);
    for (const match of matches) {
      items.push(match[1]);
    }
    return items;
  }

  private parseTasksArray(
    str: string,
  ): Array<{
    title: string;
    description: string;
    priority: "critical" | "high" | "medium" | "low";
  }> {
    const tasks: Array<{
      title: string;
      description: string;
      priority: "critical" | "high" | "medium" | "low";
    }> = [];

    try {
      const parsed = JSON.parse(`[${str}]`);
      if (Array.isArray(parsed)) {
        return parsed.map((task: any) => ({
          title: task.title || "",
          description: task.description || "",
          priority: this.normalizePriority(task.priority),
        }));
      }
    } catch (e) {
      logger.debug("Failed to parse tasks array from JSON", {
        error: String(e),
      });
    }

    const taskMatches = str.matchAll(/\{[^}]+\}/g);
    for (const match of taskMatches) {
      try {
        const task = JSON.parse(match[0]);
        tasks.push({
          title: task.title || "",
          description: task.description || "",
          priority: this.normalizePriority(task.priority),
        });
      } catch (e) {
        logger.debug("Failed to parse individual task JSON", {
          match: match[0],
          error: String(e),
        });
      }
    }

    return tasks;
  }

  private normalizePriority(
    priority: any,
  ): "critical" | "high" | "medium" | "low" {
    const p = String(priority).toLowerCase();
    if (p.includes("critical") || p.includes("severe")) return "critical";
    if (p.includes("high") || p.includes("urgent")) return "high";
    if (p.includes("low") || p.includes("minor")) return "low";
    return "medium";
  }
}
