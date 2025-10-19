import { ReviewCoordinationStep, ReviewCoordinationConfig } from './ReviewCoordinationStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { StepResult } from '../engine/WorkflowStep.js';

/**
 * QAReviewCoordinationStep - Refactored version of QAFailureCoordinationStep
 * that extends ReviewCoordinationStep base class.
 * 
 * This demonstrates how to use the base class for QA-specific coordination.
 * Most behavior is inherited from the base class, with QA-specific defaults.
 * 
 * Benefits:
 * - Eliminates duplicate parseQAStatus() code (bug was here!)
 * - Uses interpretPersonaStatus() consistently
 * - Shares task creation, PM evaluation, and plan revision logic
 * - Easy to extend with QA-specific customizations
 * 
 * To migrate existing QAFailureCoordinationStep:
 * 1. Replace QAFailureCoordinationStep with this class in step registry
 * 2. Update YAML workflows to use reviewType: 'qa' in config
 * 3. Test with existing workflows to verify behavior unchanged
 */
export class QAReviewCoordinationStep extends ReviewCoordinationStep {
  constructor(config: any) {
    super(config);
    
    // Ensure reviewType is set to 'qa'
    const stepConfig = this.config.config as ReviewCoordinationConfig;
    if (!stepConfig.reviewType) {
      (stepConfig as any).reviewType = 'qa';
    }
  }
  
  /**
   * QA-specific: Can override to add custom logic
   * Example: Check for specific test failure patterns
   */
  // protected parseReviewStatus(reviewResult: any): ParsedReviewStatus {
  //   const status = super.parseReviewStatus(reviewResult);
  //   
  //   // Add QA-specific logic here if needed
  //   // For example: parse test results, extract coverage info, etc.
  //   
  //   return status;
  // }
}

/**
 * CodeReviewCoordinationStep - Example for code review coordination
 * 
 * Uses same base class with code_review defaults:
 * - tddAware: false (code review doesn't need TDD detection)
 * - supportsIteration: false (code review failures create tasks, don't iterate)
 * - urgentPriorityScore: 1000 (slightly lower than QA)
 */
export class CodeReviewCoordinationStep extends ReviewCoordinationStep {
  constructor(config: any) {
    super(config);
    
    // Ensure reviewType is set to 'code_review'
    const stepConfig = this.config.config as ReviewCoordinationConfig;
    if (!stepConfig.reviewType) {
      (stepConfig as any).reviewType = 'code_review';
    }
  }
}

/**
 * SecurityReviewCoordinationStep - Example for security review coordination
 * 
 * Uses same base class with security_review defaults:
 * - tddAware: false
 * - supportsIteration: false
 * - urgentPriorityScore: 1100 (higher than code review, security is critical)
 */
export class SecurityReviewCoordinationStep extends ReviewCoordinationStep {
  constructor(config: any) {
    super(config);
    
    // Ensure reviewType is set to 'security_review'
    const stepConfig = this.config.config as ReviewCoordinationConfig;
    if (!stepConfig.reviewType) {
      (stepConfig as any).reviewType = 'security_review';
    }
  }
  
  /**
   * Security-specific: All security failures are urgent
   */
  protected isUrgentFailure(): boolean {
    return true; // Security issues always urgent
  }
}
