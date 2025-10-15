/**
 * Context-specific persona prompts
 * 
 * These are alternative prompts that can be dynamically selected based on
 * the workflow context (e.g., planning loop vs QA loop)
 */

export const CONTEXT_SPECIFIC_PROMPTS: Record<string, Record<string, string>> = {
  "plan-evaluator": {
    // Default: For initial planning loop (no QA involved yet)
    "planning": "Evaluate if the proposed implementation plan is concrete, actionable, and appropriate for the task. The plan should have clear steps, identify specific files to modify, and have realistic acceptance criteria. If previous evaluation feedback is provided, check that the new plan addresses those concerns. Respond with { \"status\": \"pass\" } if the plan is acceptable, or { \"status\": \"fail\", \"reason\": \"...\" } if it needs revision. Focus on PLANNING quality, not QA results.",
    
    // For QA failure coordination - evaluating plans to fix QA issues
    "qa-plan": "Evaluate if the proposed fix plan properly addresses the QA test failures. The plan should specifically target the failing tests mentioned in the QA feedback, have concrete steps to fix each failure, and include updated tests. Check that the plan is not too broad or adding unnecessary scope. Respond with { \"status\": \"pass\" } if the plan addresses the QA failures appropriately, or { \"status\": \"fail\", \"reason\": \"...\" } if it doesn't adequately address the test failures.",
    
    // For revision loops (when plan has been rejected multiple times)
    "revision": "This plan has been revised multiple times. Evaluate if this revision is a meaningful improvement over the previous attempt. Be more lenient but still ensure basic quality - the plan should have clear goals, identify files to change, and have at least minimal acceptance criteria. If the plan shows genuine effort to address feedback, lean toward passing. Respond with { \"status\": \"pass\" } or { \"status\": \"fail\", \"reason\": \"...\" }."
  },
  
  "implementation-planner": {
    // Default: Initial planning
    "default": "Plan engineering work in small, verifiable steps. If previous evaluation feedback is provided, address each point in your revised plan. Always respond with JSON containing a 'plan' array of step objects (each step should include goal, key files, owners or personas, dependencies, and acceptance criteria). Add optional sections such as 'risks', 'open_questions', or 'notes'. Never provide code or diffs. Await coordinator approval before execution.",
    
    // For QA fix planning
    "qa-fix": "Plan how to fix the specific QA test failures provided. Focus ONLY on addressing the failing tests - do not expand scope. Each step should target a specific test failure and explain how it will be fixed. Include the test file name and expected outcome. Keep the plan minimal and surgical. Respond with JSON containing a 'plan' array."
  }
}

/**
 * Get context-specific prompt for a persona
 */
export function getContextualPrompt(
  persona: string, 
  context: string = 'default'
): string | null {
  const personaContexts = CONTEXT_SPECIFIC_PROMPTS[persona]
  if (!personaContexts) return null
  
  return personaContexts[context] || personaContexts['default'] || null
}
