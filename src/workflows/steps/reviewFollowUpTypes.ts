export interface FollowUpTask {
  type?: string;
  title: string;
  description: string;
  labels?: string[];
  priority?: "critical" | "high" | "medium" | "low";
  category?: string;
  branch_locks?: Array<{ branch: string; policy: string }>;
  external_id?: string;
  metadata?: Record<string, any>;
}

export interface ExistingTask {
  title?: string;
  description?: string;
  labels?: string[];
}

export interface ReviewResult {
  reviewer?: string;
  qa_root_cause_analyses?: Array<{
    failing_capability: string;
    impact?: string;
    proposed_fix?: string | null;
    qa_gaps: string[];
    suggested_validations?: Array<{
      description: string;
      context?: string | null;
      is_critical_blocker?: boolean;
    }>;
  }>;
}

export interface NormalizedIssuePayload {
  id?: string;
  title: string;
  description: string;
  severity?: string;
  blocking?: boolean;
  labels?: string[];
  source?: string;
}

export interface NormalizedReviewPayload {
  reviewType?: string;
  reviewer?: string;
  blockingIssues?: NormalizedIssuePayload[];
  hasBlockingIssues?: boolean;
}

export interface ReviewFollowUpCoverageConfig {
  review_result?: ReviewResult | null;
  follow_up_tasks?: FollowUpTask[];
  existing_tasks?: ExistingTask[];
  review_type?: string;
  normalized_review?: NormalizedReviewPayload | null;
  task?: { id?: number | string; title?: string } | null;
  external_id_base?: string;
}

export interface CoverageItem {
  key: string;
  type: string;
  source: string;
  description: string;
  labels: string[];
  priority: FollowUpTask["priority"];
  category: FollowUpTask["category"];
  branchLocks: FollowUpTask["branch_locks"];
  blocking: boolean;
  fingerprint: string;
  severity?: string;
}

export interface CoverageSummary {
  totalCoverageItems: number;
  existingTaskMatches: number;
  synthesizedFollowUps: number;
  finalFollowUpCount: number;
  blockingFingerprints: string[];
  coverageItemBreakdown: Record<string, number>;
  branchLockCount: number;
}
