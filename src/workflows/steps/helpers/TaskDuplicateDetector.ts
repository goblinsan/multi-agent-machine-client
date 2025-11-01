

import { normalizeTitle as normalizeTitleUtil, extractKeyPhrases } from '../../../util/textNormalization.js';


export interface TaskForDuplication {
  title: string;
  description?: string;
  external_id?: string;
  milestone_slug?: string;
}


export interface ExistingTask {
  id: string;
  title: string;
  description?: string;
  external_id?: string;
  milestone_slug?: string;
  status?: string;
}


export type DuplicateMatchStrategy = 'external_id' | 'title' | 'title_and_milestone';


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
    strategy: DuplicateMatchStrategy
  ): ExistingTask | null {
    const result = this.findDuplicateWithDetails(task, existingTasks, strategy);
    return result ? result.duplicate : null;
  }

  
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
            
            const taskWords = this.extractWords(task.title);
            const existingWords = this.extractWords(existing.title);
            const intersection = new Set([...taskWords].filter(w => existingWords.has(w)));
            titleOverlap = taskWords.size > 0 ? intersection.size / taskWords.size : 0;
            matchScore = titleOverlap * 100;
          }

          if (matchScore >= 80) {
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
              
              const taskWords = this.extractWords(task.title);
              const existingWords = this.extractWords(existing.title);
              const intersection = new Set([...taskWords].filter(w => existingWords.has(w)));
              titleOverlap = taskWords.size > 0 ? intersection.size / taskWords.size : 0;
              
              
              if (task.description && existing.description) {
                const taskDescWords = this.extractWords(task.description);
                const existingDescWords = this.extractWords(existing.description);
                const descIntersection = new Set([...taskDescWords].filter(w => existingDescWords.has(w)));
                descriptionOverlap = taskDescWords.size > 0 ? descIntersection.size / taskDescWords.size : 0;
                
                
                matchScore = (titleOverlap * 0.7 + descriptionOverlap * 0.3) * 100;
              } else {
                matchScore = titleOverlap * 100;
              }
            }

            if (matchScore >= 60) {
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

  
  private normalizeTitle(title: string): string {
    return normalizeTitleUtil(title);
  }

  
  private extractWords(text: string): Set<string> {
    return extractKeyPhrases(text || '', 3);
  }
}
