/**
 * Task Duplicate Detector
 * 
 * Handles duplicate detection logic for tasks using various strategies:
 * - external_id matching (100% match)
 * - title matching (80% threshold)
 * - title_and_milestone matching (60% threshold with weighted description overlap)
 */

import { normalizeTitle as normalizeTitleUtil, extractKeyPhrases } from '../../../util/textNormalization.js';

/**
 * Task information needed for duplicate detection
 */
export interface TaskForDuplication {
  title: string;
  description?: string;
  external_id?: string;
  milestone_slug?: string;
}

/**
 * Existing task information from dashboard
 */
export interface ExistingTask {
  id: string;
  title: string;
  description?: string;
  external_id?: string;
  milestone_slug?: string;
  status?: string;
}

/**
 * Duplicate match strategies
 */
export type DuplicateMatchStrategy = 'external_id' | 'title' | 'title_and_milestone';

/**
 * Detailed duplicate match result
 */
export interface DuplicateMatchResult {
  duplicate: ExistingTask;
  strategy: DuplicateMatchStrategy;
  matchScore: number;
  titleOverlap?: number;
  descriptionOverlap?: number;
}

/**
 * TaskDuplicateDetector handles all duplicate detection logic
 */
export class TaskDuplicateDetector {
  /**
   * Find duplicate task in existing tasks list
   * 
   * @param task - Task to check for duplicates
   * @param existingTasks - List of existing tasks to check against
   * @param strategy - Match strategy to use
   * @returns Existing task if duplicate found, null otherwise
   */
  findDuplicate(
    task: TaskForDuplication,
    existingTasks: ExistingTask[],
    strategy: DuplicateMatchStrategy
  ): ExistingTask | null {
    const result = this.findDuplicateWithDetails(task, existingTasks, strategy);
    return result ? result.duplicate : null;
  }

  /**
   * Find duplicate task with detailed match information
   * 
   * @param task - Task to check for duplicates
   * @param existingTasks - List of existing tasks to check against
   * @param strategy - Match strategy to use
   * @returns Detailed match result if duplicate found, null otherwise
   */
  findDuplicateWithDetails(
    task: TaskForDuplication,
    existingTasks: ExistingTask[],
    strategy: DuplicateMatchStrategy
  ): DuplicateMatchResult | null {
    for (const existing of existingTasks) {
      let matchScore = 0;
      let titleOverlap: number | undefined;
      let descriptionOverlap: number | undefined;

      switch (strategy) {
        case 'external_id':
          if (task.external_id && existing.external_id === task.external_id) {
            return { 
              duplicate: existing, 
              strategy: 'external_id',
              matchScore: 100
            };
          }
          break;

        case 'title': {
          const taskTitle = this.normalizeTitle(task.title);
          const existingTitle = this.normalizeTitle(existing.title);
          
          if (taskTitle === existingTitle) {
            matchScore = 100;
          } else {
            // Calculate word overlap
            const taskWords = this.extractWords(task.title);
            const existingWords = this.extractWords(existing.title);
            const intersection = new Set([...taskWords].filter(w => existingWords.has(w)));
            titleOverlap = taskWords.size > 0 ? intersection.size / taskWords.size : 0;
            matchScore = titleOverlap * 100;
          }

          if (matchScore >= 80) { // 80% title match threshold
            return {
              duplicate: existing,
              strategy: 'title',
              matchScore,
              titleOverlap
            };
          }
          break;
        }

        case 'title_and_milestone': {
          const taskTitle = this.normalizeTitle(task.title);
          const existingTitle = this.normalizeTitle(existing.title);
          
          if (existing.milestone_slug === task.milestone_slug) {
            if (taskTitle === existingTitle) {
              matchScore = 100;
            } else {
              // Calculate word overlap for title
              const taskWords = this.extractWords(task.title);
              const existingWords = this.extractWords(existing.title);
              const intersection = new Set([...taskWords].filter(w => existingWords.has(w)));
              titleOverlap = taskWords.size > 0 ? intersection.size / taskWords.size : 0;
              
              // Calculate description overlap if both have descriptions
              if (task.description && existing.description) {
                const taskDescWords = this.extractWords(task.description);
                const existingDescWords = this.extractWords(existing.description);
                const descIntersection = new Set([...taskDescWords].filter(w => existingDescWords.has(w)));
                descriptionOverlap = taskDescWords.size > 0 ? descIntersection.size / taskDescWords.size : 0;
                
                // Weighted average: 70% title, 30% description
                matchScore = (titleOverlap * 0.7 + descriptionOverlap * 0.3) * 100;
              } else {
                matchScore = titleOverlap * 100;
              }
            }

            if (matchScore >= 60) { // 60% match threshold with same milestone
              return {
                duplicate: existing,
                strategy: 'title_and_milestone',
                matchScore,
                titleOverlap,
                descriptionOverlap
              };
            }
          }
          break;
        }
      }
    }

    return null;
  }

  /**
   * Calculate overlap percentage between two text strings (behavior test helper)
   * 
   * @param a - First text
   * @param b - Second text
   * @returns Overlap percentage (0-100)
   */
  calculateOverlapPercentage(a: string, b: string): number {
    const aWords = extractKeyPhrases(a || '', 3);
    const bWords = extractKeyPhrases(b || '', 3);
    
    if (aWords.size === 0) return 0;
    
    let intersection = 0;
    aWords.forEach(w => {
      if (bWords.has(w)) intersection++;
    });
    
    return (intersection / aWords.size) * 100;
  }

  /**
   * Normalize title for comparison
   */
  private normalizeTitle(title: string): string {
    return normalizeTitleUtil(title);
  }

  /**
   * Extract significant words (3+ characters) from text
   */
  private extractWords(text: string): Set<string> {
    return extractKeyPhrases(text || '', 3);
  }
}
