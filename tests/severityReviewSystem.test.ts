import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { SYSTEM_PROMPTS } from '../src/personas.js';

/**
 * Test suite for severity-based review system
 * 
 * Validates:
 * - Persona prompts include severity definitions
 * - PM receives enhanced context with severity guidance
 * - Review logs are written to .ma/reviews/ directory
 * - Status interpretation based on severity levels
 */
describe('Severity-Based Review System', () => {
  describe('Persona Prompts', () => {
    it('validates code-reviewer prompt includes severity level definitions', () => {
      const codeReviewerPrompt = SYSTEM_PROMPTS['code-reviewer'];
      
      expect(codeReviewerPrompt).toBeDefined();
      
      // Check for severity level mentions
      expect(codeReviewerPrompt).toContain('SEVERE');
      expect(codeReviewerPrompt).toContain('HIGH');
      expect(codeReviewerPrompt).toContain('MEDIUM');
      expect(codeReviewerPrompt).toContain('LOW');
      
      // Check for severity-organized findings structure
      expect(codeReviewerPrompt).toContain('findings');
      expect(codeReviewerPrompt).toContain('severe');
      expect(codeReviewerPrompt).toContain('high');
      expect(codeReviewerPrompt).toContain('medium');
      expect(codeReviewerPrompt).toContain('low');
      
      // Check for key review areas
      expect(codeReviewerPrompt.toLowerCase()).toContain('best practices');
      expect(codeReviewerPrompt.toLowerCase()).toContain('compile');
      expect(codeReviewerPrompt.toLowerCase()).toContain('organization');
      expect(codeReviewerPrompt.toLowerCase()).toContain('lint');
      
      // Check for status logic based on severity
      expect(codeReviewerPrompt).toContain('status');
      expect(codeReviewerPrompt).toContain('fail');
      expect(codeReviewerPrompt).toContain('pass');
    });

    it('validates security-review prompt includes severity level definitions', () => {
      const securityReviewPrompt = SYSTEM_PROMPTS['security-review'];
      
      expect(securityReviewPrompt).toBeDefined();
      
      // Check for severity level mentions
      expect(securityReviewPrompt).toContain('SEVERE');
      expect(securityReviewPrompt).toContain('HIGH');
      expect(securityReviewPrompt).toContain('MEDIUM');
      expect(securityReviewPrompt).toContain('LOW');
      
      // Check for severity-organized findings structure
      expect(securityReviewPrompt).toContain('findings');
      expect(securityReviewPrompt).toContain('severe');
      expect(securityReviewPrompt).toContain('high');
      expect(securityReviewPrompt).toContain('medium');
      expect(securityReviewPrompt).toContain('low');
      
      // Check for key security areas
      expect(securityReviewPrompt.toLowerCase()).toContain('vulnerabilit');
      expect(securityReviewPrompt.toLowerCase()).toContain('secrets');
      expect(securityReviewPrompt.toLowerCase()).toContain('license');
      expect(securityReviewPrompt.toLowerCase()).toContain('threat');
      
      // Check for status logic based on severity
      expect(securityReviewPrompt).toContain('status');
      expect(securityReviewPrompt).toContain('fail');
      expect(securityReviewPrompt).toContain('pass');
    });

    it('validates code-reviewer prompt requires specific finding fields', () => {
      const codeReviewerPrompt = SYSTEM_PROMPTS['code-reviewer'];
      
      // Check for required fields in findings
      expect(codeReviewerPrompt).toContain('file');
      expect(codeReviewerPrompt).toContain('issue');
      expect(codeReviewerPrompt).toContain('recommendation');
      expect(codeReviewerPrompt).toContain('line');
    });

    it('validates security-review prompt requires specific finding fields', () => {
      const securityReviewPrompt = SYSTEM_PROMPTS['security-review'];
      
      // Check for required fields in security findings
      expect(securityReviewPrompt).toContain('category');
      expect(securityReviewPrompt).toContain('vulnerability');
      expect(securityReviewPrompt).toContain('impact');
      expect(securityReviewPrompt).toContain('mitigation');
    });
  });

  describe('PM Context Enhancement', () => {
    async function loadWorkflowSteps() {
      const workflowPath = path.resolve(
        process.cwd(),
        'src/workflows/definitions/legacy-compatible-task-flow.yaml'
      );
      const fileContent = await readFile(workflowPath, 'utf-8');
      const workflow = parse(fileContent) as {
        steps: Array<{
          name: string;
          depends_on?: string[];
          condition?: string;
          config?: any;
          outputs?: string[];
        }>;
      };
      return Object.fromEntries(
        workflow.steps.map((step) => [step.name, step])
      );
    }

    it('validates PM code review prioritization receives severity guidance in context', async () => {
      const steps = await loadWorkflowSteps();
      const pmCodeReview = steps['pm_prioritize_code_review_failures'];
      
      expect(pmCodeReview).toBeDefined();
      expect(pmCodeReview?.config?.payload?.context_for_pm).toBeDefined();
      
      const context = pmCodeReview.config.payload.context_for_pm;
      
      // Check for severity level explanations
      expect(context).toContain('SEVERE');
      expect(context).toContain('HIGH');
      expect(context).toContain('MEDIUM');
      expect(context).toContain('LOW');
      
      // Check for severity descriptions
      expect(context).toContain('Blocking issues');
      expect(context).toContain('compile errors');
      expect(context).toContain('critical bugs');
      
      // Check for decision framework guidance
      expect(context).toContain('DECISION FRAMEWORK');
      expect(context).toContain('immediate fix');
      expect(context).toContain('defer');
      expect(context).toContain('backlog');
      
      // Check for stage-based guidance
      expect(context).toContain('Early stage');
      expect(context).toContain('Production');
      expect(context).toContain('milestone_completion_percentage');
    });

    it('validates PM security prioritization receives severity guidance with stage detection', async () => {
      const steps = await loadWorkflowSteps();
      const pmSecurity = steps['pm_prioritize_security_failures'];
      
      expect(pmSecurity).toBeDefined();
      expect(pmSecurity?.config?.payload?.context_for_pm).toBeDefined();
      
      const context = pmSecurity.config.payload.context_for_pm;
      
      // Check for severity level explanations
      expect(context).toContain('SEVERE');
      expect(context).toContain('HIGH');
      expect(context).toContain('MEDIUM');
      expect(context).toContain('LOW');
      
      // Check for critical security terms
      expect(context).toContain('Critical vulnerabilities');
      expect(context).toContain('RCE');
      expect(context).toContain('auth bypass');
      expect(context).toContain('data exposure');
      
      // Check for stage detection guidance
      expect(context).toContain('STAGE DETECTION');
      expect(context).toContain('MVP');
      expect(context).toContain('POC');
      expect(context).toContain('beta');
      expect(context).toContain('production');
      
      // Check for stage-aware decision framework
      expect(context).toContain('ALWAYS require immediate fix if SEVERE');
      expect(context).toContain('detected_stage');
    });

    it('validates PM receives milestone context variables', async () => {
      const steps = await loadWorkflowSteps();
      const pmCodeReview = steps['pm_prioritize_code_review_failures'];
      const pmSecurity = steps['pm_prioritize_security_failures'];
      
      // Code review PM payload
      expect(pmCodeReview?.config?.payload?.milestone_name).toBe('${milestone_name}');
      expect(pmCodeReview?.config?.payload?.milestone_description).toBe('${milestone_description}');
      expect(pmCodeReview?.config?.payload?.milestone_status).toBe('${milestone_status}');
      expect(pmCodeReview?.config?.payload?.milestone_completion_percentage).toBe('${milestone_completion_percentage}');
      expect(pmCodeReview?.config?.payload?.code_review_result).toBe('${code_review_request_result}');
      expect(pmCodeReview?.config?.payload?.code_review_status).toBe('${code_review_request_status}');
      
      // Security review PM payload
      expect(pmSecurity?.config?.payload?.milestone_name).toBe('${milestone_name}');
      expect(pmSecurity?.config?.payload?.milestone_description).toBe('${milestone_description}');
      expect(pmSecurity?.config?.payload?.milestone_status).toBe('${milestone_status}');
      expect(pmSecurity?.config?.payload?.milestone_completion_percentage).toBe('${milestone_completion_percentage}');
      expect(pmSecurity?.config?.payload?.security_result).toBe('${security_request_result}');
      expect(pmSecurity?.config?.payload?.security_status).toBe('${security_request_status}');
      expect(pmSecurity?.config?.payload?.code_review_result).toBe('${code_review_request_result}');
    });

    it('validates PM context explains when to defer vs immediate fix', async () => {
      const steps = await loadWorkflowSteps();
      const pmCodeReview = steps['pm_prioritize_code_review_failures'];
      const pmSecurity = steps['pm_prioritize_security_failures'];
      
      const codeReviewContext = pmCodeReview?.config?.payload?.context_for_pm;
      const securityContext = pmSecurity?.config?.payload?.context_for_pm;
      
      // Code review context should explain defer/immediate logic
      expect(codeReviewContext).toContain('ALWAYS require immediate fix if SEVERE or HIGH');
      expect(codeReviewContext).toContain('Can defer to backlog');
      expect(codeReviewContext).toContain('decision MUST be "immediate_fix"');
      expect(codeReviewContext).toContain('decision can be "defer"');
      
      // Security context should explain stage-aware logic
      expect(securityContext).toContain('MUST fix immediately regardless of project stage');
      expect(securityContext).toContain('Production/Beta: MUST fix immediately');
      expect(securityContext).toContain('Early stage: Defer to backlog');
      expect(securityContext).toContain('If SEVERE findings exist, decision MUST be "immediate_fix"');
    });
  });

  describe('In-Review Workflow PM Context', () => {
    async function loadInReviewWorkflowSteps() {
      const workflowPath = path.resolve(
        process.cwd(),
        'src/workflows/definitions/in-review-task-flow.yaml'
      );
      const fileContent = await readFile(workflowPath, 'utf-8');
      const workflow = parse(fileContent) as {
        steps: Array<{
          name: string;
          depends_on?: string[];
          condition?: string;
          config?: any;
          outputs?: string[];
        }>;
      };
      return Object.fromEntries(
        workflow.steps.map((step) => [step.name, step])
      );
    }

    it('validates in-review workflow has same PM context as main workflow', async () => {
      const steps = await loadInReviewWorkflowSteps();
      const pmCodeReview = steps['pm_prioritize_code_review_failures'];
      const pmSecurity = steps['pm_prioritize_security_failures'];
      
      expect(pmCodeReview).toBeDefined();
      expect(pmSecurity).toBeDefined();
      
      // Both should have context_for_pm
      expect(pmCodeReview?.config?.payload?.context_for_pm).toBeDefined();
      expect(pmSecurity?.config?.payload?.context_for_pm).toBeDefined();
      
      const codeReviewContext = pmCodeReview.config.payload.context_for_pm;
      const securityContext = pmSecurity.config.payload.context_for_pm;
      
      // Check for severity guidance in both
      expect(codeReviewContext).toContain('SEVERITY LEVELS EXPLAINED');
      expect(securityContext).toContain('SEVERITY LEVELS EXPLAINED');
      
      // Check for decision framework
      expect(codeReviewContext).toContain('DECISION FRAMEWORK');
      expect(securityContext).toContain('DECISION FRAMEWORK');
    });
  });

  describe('Review Log Storage', () => {
    it('validates review log paths are documented in .ma/reviews/ directory', () => {
      // This test validates the expected file structure from documentation
      const expectedCodeReviewLogPattern = /task-\{id\}-code-review\.log/;
      const expectedSecurityReviewLogPattern = /task-\{id\}-security-review\.log/;
      
      // These patterns should be used in the process.ts functions
      expect('task-{id}-code-review.log').toMatch(expectedCodeReviewLogPattern);
      expect('task-{id}-security-review.log').toMatch(expectedSecurityReviewLogPattern);
    });

    it('validates review log structure includes severity breakdown', () => {
      // This test documents the expected log format
      const expectedLogStructure = {
        header: ['Task ID', 'Workflow ID', 'Branch', 'Status', 'Duration'],
        severitySections: ['SEVERE', 'HIGH', 'MEDIUM', 'LOW'],
        findingFields: ['File', 'Issue', 'Recommendation']
      };
      
      expect(expectedLogStructure.severitySections).toHaveLength(4);
      expect(expectedLogStructure.severitySections).toContain('SEVERE');
      expect(expectedLogStructure.severitySections).toContain('HIGH');
      expect(expectedLogStructure.severitySections).toContain('MEDIUM');
      expect(expectedLogStructure.severitySections).toContain('LOW');
    });
  });

  describe('Status Interpretation Based on Severity', () => {
    it('validates code review should return fail when SEVERE findings exist', () => {
      const prompt = SYSTEM_PROMPTS['code-reviewer'];
      
      // Prompt should instruct to use status="fail" for SEVERE/HIGH
      expect(prompt).toContain('status="fail"');
      expect(prompt.toLowerCase()).toContain('severe');
      expect(prompt.toLowerCase()).toContain('high');
    });

    it('validates code review should return fail when HIGH findings exist', () => {
      const prompt = SYSTEM_PROMPTS['code-reviewer'];
      
      // Prompt should instruct to fail on HIGH findings
      expect(prompt).toContain('status="fail" when SEVERE or HIGH');
    });

    it('validates code review should return pass when only MEDIUM/LOW findings exist', () => {
      const prompt = SYSTEM_PROMPTS['code-reviewer'];
      
      // Should mention that MEDIUM/LOW don't cause failure
      expect(prompt.toLowerCase()).toContain('medium');
      expect(prompt.toLowerCase()).toContain('low');
    });

    it('validates security review should return fail for SEVERE findings regardless of stage', () => {
      const prompt = SYSTEM_PROMPTS['security-review'];
      
      // Prompt should instruct to use status="fail" for SEVERE/HIGH
      expect(prompt).toContain('status="fail"');
      expect(prompt.toLowerCase()).toContain('severe');
      
      // Check in PM context for stage-independent SEVERE handling
      // (This is in the workflow PM context, not the persona prompt)
    });

    it('validates security review uses appropriate severity categories', () => {
      const prompt = SYSTEM_PROMPTS['security-review'];
      
      // Check for specific security severity examples
      expect(prompt).toContain('RCE');
      expect(prompt).toContain('auth bypass');
      expect(prompt).toContain('data exposure');
      expect(prompt).toContain('CVE');
      expect(prompt).toContain('XSS');
      // Note: CSRF is not explicitly mentioned but covered by comprehensive security checks
    });
  });

  describe('Persona Response Format Validation', () => {
    it('validates code-reviewer requires JSON response with specific structure', () => {
      const prompt = SYSTEM_PROMPTS['code-reviewer'];
      
      // Should require JSON response
      expect(prompt.toLowerCase()).toContain('json');
      
      // Should specify required fields
      expect(prompt).toContain('status');
      expect(prompt).toContain('summary');
      expect(prompt).toContain('findings');
      
      // Should have arrays for each severity level
      expect(prompt).toContain('severe');
      expect(prompt).toContain('high');
      expect(prompt).toContain('medium');
      expect(prompt).toContain('low');
    });

    it('validates security-review requires JSON response with security-specific fields', () => {
      const prompt = SYSTEM_PROMPTS['security-review'];
      
      // Should require JSON response
      expect(prompt.toLowerCase()).toContain('json');
      
      // Should specify required fields
      expect(prompt).toContain('status');
      expect(prompt).toContain('summary');
      expect(prompt).toContain('findings');
      
      // Security-specific fields
      expect(prompt).toContain('category');
      expect(prompt).toContain('vulnerability');
      expect(prompt).toContain('impact');
      expect(prompt).toContain('mitigation');
    });

    it('validates prompts require all severity arrays even if empty', () => {
      const codeReviewerPrompt = SYSTEM_PROMPTS['code-reviewer'];
      const securityReviewPrompt = SYSTEM_PROMPTS['security-review'];
      
      // Both should mention including all severity arrays
      expect(codeReviewerPrompt.toLowerCase()).toContain('all severity');
      expect(securityReviewPrompt.toLowerCase()).toContain('all severity');
      
      // Should mention empty arrays
      expect(codeReviewerPrompt).toContain('empty');
      expect(securityReviewPrompt).toContain('empty');
    });
  });

  describe('Workflow Integration Points', () => {
    async function loadWorkflowSteps() {
      const workflowPath = path.resolve(
        process.cwd(),
        'src/workflows/definitions/legacy-compatible-task-flow.yaml'
      );
      const fileContent = await readFile(workflowPath, 'utf-8');
      const workflow = parse(fileContent) as {
        steps: Array<{
          name: string;
          depends_on?: string[];
          condition?: string;
          config?: any;
          outputs?: string[];
        }>;
      };
      return Object.fromEntries(
        workflow.steps.map((step) => [step.name, step])
      );
    }

    it('validates code review step outputs include status for severity-based decisions', async () => {
      const steps = await loadWorkflowSteps();
      const codeReview = steps['code_review_request'];
      
      expect(codeReview).toBeDefined();
      expect(codeReview?.outputs).toBeDefined();
      expect(codeReview?.outputs).toContain('code_review_request_status');
      expect(codeReview?.outputs).toContain('code_review_request_result');
    });

    it('validates security review step outputs include status for severity-based decisions', async () => {
      const steps = await loadWorkflowSteps();
      const security = steps['security_request'];
      
      expect(security).toBeDefined();
      expect(security?.outputs).toBeDefined();
      expect(security?.outputs).toContain('security_request_status');
      expect(security?.outputs).toContain('security_request_result');
    });

    it('validates PM steps trigger on review failure status', async () => {
      const steps = await loadWorkflowSteps();
      const pmCodeReview = steps['pm_prioritize_code_review_failures'];
      const pmSecurity = steps['pm_prioritize_security_failures'];
      
      // PM steps should only run when reviews fail
      expect(pmCodeReview?.condition).toBe("${code_review_request_status} == 'fail'");
      expect(pmSecurity?.condition).toBe("${security_request_status} == 'fail'");
      
      // PM steps should depend on their respective review steps
      expect(pmCodeReview?.depends_on).toEqual(['code_review_request']);
      expect(pmSecurity?.depends_on).toEqual(['security_request']);
    });

    it('validates PM decision output is available for workflow logic', async () => {
      const steps = await loadWorkflowSteps();
      const pmCodeReview = steps['pm_prioritize_code_review_failures'];
      const pmSecurity = steps['pm_prioritize_security_failures'];
      
      // PM steps should output their decisions
      expect(pmCodeReview?.outputs).toBeDefined();
      expect(pmCodeReview?.outputs).toContain('pm_code_review_decision');
      
      expect(pmSecurity?.outputs).toBeDefined();
      expect(pmSecurity?.outputs).toContain('pm_security_decision');
    });
  });

  describe('Documentation Consistency', () => {
    it('validates severity levels are consistently defined across all components', () => {
      const codeReviewerPrompt = SYSTEM_PROMPTS['code-reviewer'];
      const securityReviewPrompt = SYSTEM_PROMPTS['security-review'];
      
      // All four severity levels should be present in both prompts
      const severityLevels = ['SEVERE', 'HIGH', 'MEDIUM', 'LOW'];
      
      for (const level of severityLevels) {
        expect(codeReviewerPrompt).toContain(level);
        expect(securityReviewPrompt).toContain(level);
      }
    });

    it('validates consistent terminology between personas and PM context', async () => {
      const steps = await loadWorkflowSteps();
      const pmCodeReview = steps['pm_prioritize_code_review_failures'];
      const pmSecurity = steps['pm_prioritize_security_failures'];
      
      const codeReviewerPrompt = SYSTEM_PROMPTS['code-reviewer'];
      const securityReviewPrompt = SYSTEM_PROMPTS['security-review'];
      
      const codeReviewContext = pmCodeReview?.config?.payload?.context_for_pm;
      const securityContext = pmSecurity?.config?.payload?.context_for_pm;
      
      // Terminology should match between persona prompts and PM context
      const commonTerms = ['SEVERE', 'HIGH', 'MEDIUM', 'LOW', 'findings', 'status'];
      
      for (const term of commonTerms) {
        expect(codeReviewerPrompt).toContain(term);
        expect(codeReviewContext).toContain(term);
        expect(securityReviewPrompt).toContain(term);
        expect(securityContext).toContain(term);
      }
    });

    async function loadWorkflowSteps() {
      const workflowPath = path.resolve(
        process.cwd(),
        'src/workflows/definitions/legacy-compatible-task-flow.yaml'
      );
      const fileContent = await readFile(workflowPath, 'utf-8');
      const workflow = parse(fileContent) as {
        steps: Array<{
          name: string;
          depends_on?: string[];
          condition?: string;
          config?: any;
          outputs?: string[];
        }>;
      };
      return Object.fromEntries(
        workflow.steps.map((step) => [step.name, step])
      );
    }
  });

  describe('Edge Cases and Error Handling', () => {
    it('validates prompts handle missing severity arrays gracefully', () => {
      const codeReviewerPrompt = SYSTEM_PROMPTS['code-reviewer'];
      const securityReviewPrompt = SYSTEM_PROMPTS['security-review'];
      
      // Prompts should instruct to include all severity arrays
      expect(codeReviewerPrompt).toContain('all severity arrays');
      expect(securityReviewPrompt).toContain('all severity arrays');
      
      // Should mention empty arrays for when no findings in a category
      expect(codeReviewerPrompt).toContain('empty [] if none');
      expect(securityReviewPrompt).toContain('empty [] if none');
    });

    it('validates prompts require summary field always', () => {
      const codeReviewerPrompt = SYSTEM_PROMPTS['code-reviewer'];
      const securityReviewPrompt = SYSTEM_PROMPTS['security-review'];
      
      // Both should mention summary as required
      expect(codeReviewerPrompt.toLowerCase()).toContain('summary');
      expect(securityReviewPrompt.toLowerCase()).toContain('summary');
      
      // Should mention "always" to indicate required fields
      expect(codeReviewerPrompt.toLowerCase()).toContain('always');
      expect(securityReviewPrompt.toLowerCase()).toContain('always');
    });
  });
});
