export const PERSONAS = {
  SUMMARIZATION: "summarization",
  COORDINATION: "coordination",
  CONTEXT: "context",
  IMPLEMENTATION_PLANNER: "implementation-planner",
  LEAD_ENGINEER: "lead-engineer",
  TESTER_QA: "tester-qa",
  PROJECT_MANAGER: "project-manager",
  DEVOPS: "devops",
  CODE_REVIEWER: "code-reviewer",
  SECURITY_REVIEW: "security-review",
  UI_ENGINEER: "ui-engineer",
  TROUBLESHOOTING: "troubleshooting",
  ARCHITECT: "architect",
  PLAN_EVALUATOR: "plan-evaluator",
  RESEARCHER: "researcher",
} as const;

export type PersonaName = (typeof PERSONAS)[keyof typeof PERSONAS];
