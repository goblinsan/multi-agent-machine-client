import { createHash } from "crypto";
import {
  normalizeTitle as normalizeTitleUtil,
  extractKeyPhrases,
} from "../../../util/textNormalization.js";

const CONTENT_TOKEN_MIN_LENGTH = 4;

export interface TaskForDuplication {
  title: string;
  description?: string;
  external_id?: string;
  milestone_slug?: string;
  content_hash?: string;
}

export interface ExistingTask {
  id: string;
  title: string;
  description?: string;
  external_id?: string;
  milestone_slug?: string;
  status?: string;
  content_hash?: string;
}

export type DuplicateMatchStrategy =
  | "external_id"
  | "title"
  | "title_and_milestone"
  | "content_hash";

export interface DuplicateMatchResult {
  duplicate: ExistingTask;
  strategy: DuplicateMatchStrategy;
  matchScore: number;
  titleOverlap?: number;
  descriptionOverlap?: number;
}

export class TaskDuplicateDetector {
  findDuplicate(
    task: TaskForDuplication,
    existingTasks: ExistingTask[],
    strategy: DuplicateMatchStrategy,
  ): ExistingTask | null {
    const result = this.findDuplicateWithDetails(task, existingTasks, strategy);
    return result ? result.duplicate : null;
  }

  findDuplicateWithDetails(
    task: TaskForDuplication,
    existingTasks: ExistingTask[],
    strategy: DuplicateMatchStrategy,
  ): DuplicateMatchResult | null {
    for (const existing of existingTasks) {
      let matchScore = 0;
      let titleOverlap: number | undefined;
      let descriptionOverlap: number | undefined;

      switch (strategy) {
        case "external_id":
          if (task.external_id && existing.external_id === task.external_id) {
            return {
              duplicate: existing,
              strategy: "external_id",
              matchScore: 100,
            };
          }
          break;

        case "title": {
          const taskTitle = this.normalizeTitle(task.title);
          const existingTitle = this.normalizeTitle(existing.title);

          if (taskTitle === existingTitle) {
            matchScore = 100;
          } else {
            const taskWords = this.extractWords(task.title);
            const existingWords = this.extractWords(existing.title);
            const intersection = new Set(
              [...taskWords].filter((w) => existingWords.has(w)),
            );
            titleOverlap =
              taskWords.size > 0 ? intersection.size / taskWords.size : 0;
            matchScore = titleOverlap * 100;
          }

          if (matchScore >= 80) {
            return {
              duplicate: existing,
              strategy: "title",
              matchScore,
              titleOverlap,
            };
          }
          break;
        }

        case "content_hash": {
          const contentMatch = this.compareByContentHash(task, existing);
          if (contentMatch) {
            return contentMatch;
          }
          break;
        }

        case "title_and_milestone": {
          const taskTitle = this.normalizeTitle(task.title);
          const existingTitle = this.normalizeTitle(existing.title);

          if (existing.milestone_slug === task.milestone_slug) {
            if (taskTitle === existingTitle) {
              matchScore = 100;
            } else {
              const taskWords = this.extractWords(task.title);
              const existingWords = this.extractWords(existing.title);
              const intersection = new Set(
                [...taskWords].filter((w) => existingWords.has(w)),
              );
              titleOverlap =
                taskWords.size > 0 ? intersection.size / taskWords.size : 0;

              if (task.description && existing.description) {
                const taskDescWords = this.extractWords(task.description);
                const existingDescWords = this.extractWords(
                  existing.description,
                );
                const descIntersection = new Set(
                  [...taskDescWords].filter((w) => existingDescWords.has(w)),
                );
                descriptionOverlap =
                  taskDescWords.size > 0
                    ? descIntersection.size / taskDescWords.size
                    : 0;

                matchScore =
                  (titleOverlap * 0.7 + descriptionOverlap * 0.3) * 100;
              } else {
                matchScore = titleOverlap * 100;
              }
            }

            if (matchScore >= 60) {
              return {
                duplicate: existing,
                strategy: "title_and_milestone",
                matchScore,
                titleOverlap,
                descriptionOverlap,
              };
            }
          }
          break;
        }
      }
    }

    return null;
  }

  calculateOverlapPercentage(a: string, b: string): number {
    const aWords = extractKeyPhrases(a || "", 3);
    const bWords = extractKeyPhrases(b || "", 3);

    if (aWords.size === 0) return 0;

    let intersection = 0;
    aWords.forEach((w) => {
      if (bWords.has(w)) intersection++;
    });

    return (intersection / aWords.size) * 100;
  }

  private normalizeTitle(title: string): string {
    return normalizeTitleUtil(title);
  }

  private extractWords(text: string): Set<string> {
    return extractKeyPhrases(text || "", 3);
  }

  getContentHash(task: TaskForDuplication): string | null {
    return this.computeContentHash(task);
  }

  private compareByContentHash(
    task: TaskForDuplication,
    existing: ExistingTask,
  ): DuplicateMatchResult | null {
    if (
      task.milestone_slug &&
      existing.milestone_slug &&
      task.milestone_slug !== existing.milestone_slug
    ) {
      return null;
    }

    const taskHash = this.computeContentHash(task);
    const existingHash = this.computeContentHash(existing);

    if (taskHash && existingHash && taskHash === existingHash) {
      return {
        duplicate: existing,
        strategy: "content_hash",
        matchScore: 100,
      };
    }

    const overlapScore = this.calculateContentOverlap(task, existing);
    if (overlapScore >= 70) {
      return {
        duplicate: existing,
        strategy: "content_hash",
        matchScore: overlapScore,
      };
    }

    return null;
  }

  private calculateContentOverlap(
    task: TaskForDuplication,
    existing: ExistingTask,
  ): number {
    const taskTokens = this.extractContentTokens(task);
    const existingTokens = this.extractContentTokens(existing);

    if (taskTokens.size === 0 || existingTokens.size === 0) {
      return 0;
    }

    let intersection = 0;
    taskTokens.forEach((token) => {
      if (existingTokens.has(token)) {
        intersection++;
      }
    });

    const denominator = Math.min(taskTokens.size, existingTokens.size);
    if (denominator === 0) {
      return 0;
    }

    return (intersection / denominator) * 100;
  }

  private extractContentTokens(
    task: TaskForDuplication | ExistingTask,
  ): Set<string> {
    const combined = `${task.title || ""} ${task.description || ""}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    if (!combined) {
      return new Set();
    }

    const tokens = combined
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= CONTENT_TOKEN_MIN_LENGTH);

    return new Set(tokens);
  }

  private computeContentHash(
    task: TaskForDuplication | ExistingTask,
  ): string | null {
    if (task.content_hash && typeof task.content_hash === "string") {
      return task.content_hash;
    }

    const fingerprint = this.buildContentFingerprint(task);
    if (!fingerprint) {
      return null;
    }

    return createHash("sha256").update(fingerprint).digest("hex");
  }

  private buildContentFingerprint(
    task: TaskForDuplication | ExistingTask,
  ): string | null {
    const tokens = Array.from(this.extractContentTokens(task)).sort();
    if (tokens.length === 0) {
      return null;
    }

    const milestoneComponent = task.milestone_slug
      ? `|milestone:${task.milestone_slug}`
      : "";

    return `${tokens.join("|")}${milestoneComponent}`;
  }
}
