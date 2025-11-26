import { TaskPriority } from "./TaskPriorityCalculator.js";

export interface TestCommandCandidate {
  command?: string;
  framework?: string;
  language?: string;
  confidence?: number;
  status?: string;
  type?: string;
  reason?: string;
  source?: string;
  source_paths?: string[];
  working_directory?: string;
  prerequisites?: string[];
  coverage?: string;
  notes?: string[];
}

export interface TestHarnessPlanSuggestion {
  language?: string;
  framework?: string;
  command?: string;
  title?: string;
  summary?: string;
  priority?: TaskPriority;
  dependencies?: string[];
  steps?: string[];
  labels?: string[];
  rationale?: string;
  source?: string;
}

export interface TestCommandManifest {
  preferred_command?: string;
  candidates?: TestCommandCandidate[];
  harness_plan?: TestHarnessPlanSuggestion | null;
  blockers?: Array<{ reason?: string; severity?: string }>;
  notes?: string[];
  metadata?: Record<string, unknown>;
}
