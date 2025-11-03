const PERSONAS_REQUIRING_STATUS = new Set([
  "plan-evaluator",
  "tester-qa",
  "code-reviewer",
  "security-review",
]);

export function requiresStatus(persona?: string): boolean {
  if (!persona) return false;
  return PERSONAS_REQUIRING_STATUS.has(persona);
}
