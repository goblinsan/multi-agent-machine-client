export type PersonaStatus = "pass" | "fail" | "unknown";

export interface AnalysisReviewLoopConfig {
  maxIterations?: number;
  analystPersona: string;
  reviewerPersona: string;
  analysisStep?: string;
  reviewStep?: string;
  analysisIntent?: string;
  reviewIntent?: string;
  analysisPromptTemplate?: string;
  reviewPromptTemplate?: string;
  payload?: Record<string, any>;
  reviewPayload?: Record<string, any>;
  deadlineSeconds?: number;
  analysisTimeout?: number;
  reviewTimeout?: number;
  analysisMaxRetries?: number;
  reviewMaxRetries?: number;
  autoPassReason?: string;
}

export interface PersonaInvocationConfig {
  name: string;
  step: string;
  persona: string;
  intent: string;
  payload: Record<string, any>;
  promptTemplate?: string;
  timeout?: number;
  deadlineSeconds?: number;
  maxRetries?: number;
  abortOnFailure?: boolean;
}

export interface NormalizedReviewFeedback {
  text: string;
  summary?: string;
  requiredRevisions?: string[];
  reason?: string;
  status?: string;
}

export interface ReviewHistoryEntry {
  iteration: number;
  raw: any;
  normalized?: NormalizedReviewFeedback | null;
}
