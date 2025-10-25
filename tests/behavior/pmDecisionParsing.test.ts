/**
 * Test Group 2: PM Decision Parsing - Consolidated Behavior Tests
 * 
 * Based on: docs/test-rationalization/TEST_GROUP_2_PM_DECISION_PARSING.md
 * 
 * This test file consolidates behavior from:
 * - tests/productionCodeReviewFailure.test.ts (154 lines)
 * - tests/initialPlanningAckAndEval.test.ts (100 lines)
 * - tests/qaPmGating.test.ts (100 lines)
 * - src/workflows/steps/PMDecisionParserStep.ts (347 lines - modern implementation)
 * - src/workflows/steps/ReviewFailureTasksStep.ts (540 lines - old parser)
 * 
 * Key Validated Behaviors:
 * 1. Single consolidated parser (PMDecisionParserStep only)
 * 2. 7 PM response formats handled (JSON, text, nested, markdown, status vs decision)
 * 3. Backlog field deprecated (merge with follow_up_tasks if both present)
 * 4. Follow-up task routing (critical/high → same milestone, medium/low → backlog)
 * 5. Priority validation (QA=1200, Code/Security/DevOps=1000, deferred=50)
 * 6. Production bug fix (backlog + follow_up_tasks both present → merge arrays)
 * 
 * Implementation Status: ⏳ Tests written, implementation pending Phase 4
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PMDecisionParserStep } from '../../src/workflows/steps/PMDecisionParserStep.js';
import { WorkflowContext } from '../../src/workflows/WorkflowEngine.js';

describe('PM Decision Parsing', () => {
  let parser: PMDecisionParserStep;

  beforeEach(() => {
    parser = new PMDecisionParserStep({
      persona: 'lead-engineer',
      prompt_template: 'pm-prioritize-qa-failures'
    });
  });

  describe('Format 1: Clean JSON with follow_up_tasks array', () => {
    it('should parse standard JSON response correctly', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        explanation: 'Test failures must be fixed immediately',
        follow_up_tasks: [
          {
            title: '🚨 [QA] Fix authentication test',
            description: 'Tests are failing due to incorrect mock setup',
            priority: 'critical',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123',
        task_id: 'task-456'
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision).toMatchObject({
        immediate_fix: true,
        explanation: 'Test failures must be fixed immediately',
        follow_up_tasks: [
          {
            title: '🚨 [QA] Fix authentication test',
            priority: 1200, // Critical QA = 1200
            milestone_id: 'milestone-123', // Same milestone
            assignee_persona: 'implementation-planner'
          }
        ]
      });
    });
  });

  describe('Format 2: Nested JSON wrapper', () => {
    it('should extract decision from nested json field', async () => {
      const pmResponse = JSON.stringify({
        json: {
          immediate_fix: false,
          explanation: 'Low priority code style issue',
          follow_up_tasks: [
            {
              title: '📋 [Code] Refactor validation logic',
              description: 'Extract duplicated validation code',
              priority: 'low',
              assignee_persona: 'implementation-planner'
            }
          ]
        }
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123',
        backlog_milestone_id: 'backlog-milestone'
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision).toMatchObject({
        immediate_fix: false,
        follow_up_tasks: [
          {
            title: '📋 [Code] Refactor validation logic',
            priority: 50, // Low priority = 50
            milestone_id: 'backlog-milestone', // Deferred to backlog
            assignee_persona: 'implementation-planner'
          }
        ]
      });
    });
  });

  describe('Format 3: Text with embedded JSON', () => {
    it('should extract JSON from markdown code blocks', async () => {
      const pmResponse = `
Looking at the security findings, we need immediate action.

\`\`\`json
{
  "immediate_fix": true,
  "explanation": "SQL injection vulnerability is critical",
  "follow_up_tasks": [
    {
      "title": "🚨 [Security] Fix SQL injection in query builder",
      "description": "Use parameterized queries",
      "priority": "critical",
      "assignee_persona": "implementation-planner"
    }
  ]
}
\`\`\`

This should be addressed before deployment.
      `;

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123'
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision).toMatchObject({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: '🚨 [Security] Fix SQL injection in query builder',
            priority: 1000, // Critical Security = 1000
            milestone_id: 'milestone-123'
          }
        ]
      });
    });
  });

  describe('Format 4: Backlog field (deprecated)', () => {
    it('should move backlog tasks to follow_up_tasks with warning', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: false,
        explanation: 'Minor improvements can be deferred',
        backlog: [
          {
            title: '📋 [Code] Add JSDoc comments',
            description: 'Improve code documentation',
            priority: 'low',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        backlog_milestone_id: 'backlog-milestone'
      };

      const result = await parser.execute(context);

      // Should move to follow_up_tasks
      expect(result.context.pm_decision.follow_up_tasks).toHaveLength(1);
      expect(result.context.pm_decision.backlog).toBeUndefined();

      // Should log deprecation warning
      expect(result.warnings).toContainEqual(
        expect.stringContaining('PM used deprecated "backlog" field')
      );
    });
  });

  describe('Format 5: Production Bug - Both backlog AND follow_up_tasks', () => {
    it('should merge both arrays when PM returns both fields', async () => {
      // This is the PRODUCTION BUG we found:
      // PM returned BOTH backlog (1 task) and follow_up_tasks (2 tasks)
      // Result: 0 tasks created (parser chose backlog, but it was wrong field)
      
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        explanation: 'Multiple issues found',
        backlog: [
          {
            title: '📋 [Code] Refactor error handling',
            description: 'Consolidate error handling logic',
            priority: 'medium',
            assignee_persona: 'implementation-planner'
          }
        ],
        follow_up_tasks: [
          {
            title: '🚨 [QA] Fix test timeout',
            description: 'Tests timing out in CI',
            priority: 'critical',
            assignee_persona: 'implementation-planner'
          },
          {
            title: '🚨 [Security] Update dependency',
            description: 'Security vulnerability in lodash',
            priority: 'high',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123',
        backlog_milestone_id: 'backlog-milestone'
      };

      const result = await parser.execute(context);

      // BUG FIX: Should merge both arrays (3 total tasks)
      expect(result.context.pm_decision.follow_up_tasks).toHaveLength(3);

      // Should route correctly
      const tasks = result.context.pm_decision.follow_up_tasks;
      expect(tasks.find(t => t.title.includes('QA'))).toMatchObject({
        priority: 1200, // Critical QA
        milestone_id: 'milestone-123' // Immediate
      });
      expect(tasks.find(t => t.title.includes('Security'))).toMatchObject({
        priority: 1000, // High Security
        milestone_id: 'milestone-123' // Immediate
      });
      expect(tasks.find(t => t.title.includes('Refactor'))).toMatchObject({
        priority: 50, // Medium deferred
        milestone_id: 'backlog-milestone' // Backlog
      });

      // Should log warning about both fields
      expect(result.warnings).toContainEqual(
        expect.stringContaining('PM returned both "backlog" and "follow_up_tasks"')
      );
    });
  });

  describe('Format 6: status vs decision field', () => {
    it('should handle "status" field (instead of "decision")', async () => {
      const pmResponse = JSON.stringify({
        status: 'immediate_fix_required',
        immediate_fix: true,
        explanation: 'Critical bug blocking release',
        follow_up_tasks: [
          {
            title: '🚨 [QA] Fix regression in payment flow',
            priority: 'critical',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123'
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision).toMatchObject({
        immediate_fix: true,
        follow_up_tasks: expect.arrayContaining([
          expect.objectContaining({
            title: '🚨 [QA] Fix regression in payment flow',
            priority: 1200
          })
        ])
      });
    });
  });

  describe('Format 7: Plain text (fallback)', () => {
    it('should handle plain text without JSON', async () => {
      const pmResponse = `
The code review findings are minor style issues that don't block deployment.
We can create a follow-up task to address these in the next sprint.
No immediate action required.
      `;

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123'
      };

      const result = await parser.execute(context);

      // Should infer immediate_fix = false from text analysis
      expect(result.context.pm_decision.immediate_fix).toBe(false);

      // Should have empty follow_up_tasks array (no structured data)
      expect(result.context.pm_decision.follow_up_tasks).toEqual([]);
    });
  });

  describe('Priority Validation', () => {
    it('should map QA critical/high to priority 1200', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: '🚨 [QA] Critical test failure',
            priority: 'critical',
            assignee_persona: 'implementation-planner'
          },
          {
            title: '🚨 [QA] High priority test failure',
            priority: 'high',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123'
      };

      const result = await parser.execute(context);

      result.context.pm_decision.follow_up_tasks.forEach(task => {
        expect(task.priority).toBe(1200); // QA always 1200
      });
    });

    it('should map Code/Security/DevOps critical/high to priority 1000', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: '🚨 [Code] Critical refactor needed',
            priority: 'critical',
            assignee_persona: 'implementation-planner'
          },
          {
            title: '🚨 [Security] High risk vulnerability',
            priority: 'high',
            assignee_persona: 'implementation-planner'
          },
          {
            title: '🚨 [DevOps] Build failing',
            priority: 'critical',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123'
      };

      const result = await parser.execute(context);

      result.context.pm_decision.follow_up_tasks.forEach(task => {
        expect(task.priority).toBe(1000); // Code/Security/DevOps = 1000
      });
    });

    it('should map medium/low to priority 50 (deferred)', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: false,
        follow_up_tasks: [
          {
            title: '📋 [Code] Medium: Refactor duplicated code',
            priority: 'medium',
            assignee_persona: 'implementation-planner'
          },
          {
            title: '📋 [Security] Low: Update documentation',
            priority: 'low',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        backlog_milestone_id: 'backlog-milestone'
      };

      const result = await parser.execute(context);

      result.context.pm_decision.follow_up_tasks.forEach(task => {
        expect(task.priority).toBe(50); // Deferred = 50
        expect(task.milestone_id).toBe('backlog-milestone');
      });
    });
  });

  describe('Milestone Routing', () => {
    it('should route critical/high to parent milestone (same milestone)', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: '🚨 [QA] Critical failure',
            priority: 'critical',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123',
        parent_task_milestone_id: 'milestone-123'
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision.follow_up_tasks[0]).toMatchObject({
        milestone_id: 'milestone-123', // Same as parent
        priority: 1200
      });
    });

    it('should route medium/low to backlog milestone', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: false,
        follow_up_tasks: [
          {
            title: '📋 [Code] Low priority refactor',
            priority: 'low',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123',
        backlog_milestone_id: 'backlog-999'
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision.follow_up_tasks[0]).toMatchObject({
        milestone_id: 'backlog-999', // Routed to backlog
        priority: 50
      });
    });

    it('should handle missing parent milestone (edge case)', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: '🚨 [QA] Critical failure',
            priority: 'critical',
            assignee_persona: 'implementation-planner'
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: null, // Missing!
        backlog_milestone_id: 'backlog-999'
      };

      const result = await parser.execute(context);

      // Should fall back to backlog milestone with warning
      expect(result.context.pm_decision.follow_up_tasks[0].milestone_id).toBe('backlog-999');
      expect(result.warnings).toContainEqual(
        expect.stringContaining('Parent milestone not found')
      );
    });
  });

  describe('Assignee Validation', () => {
    it('should always set assignee_persona to implementation-planner', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: '🚨 [QA] Test failure',
            priority: 'critical',
            assignee_persona: 'tester-qa' // Wrong! Should be overridden
          },
          {
            title: '🚨 [Code] Code issue',
            priority: 'high'
            // Missing assignee_persona, should be added
          }
        ]
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123'
      };

      const result = await parser.execute(context);

      result.context.pm_decision.follow_up_tasks.forEach(task => {
        expect(task.assignee_persona).toBe('implementation-planner');
      });
    });
  });

  describe('Empty follow_up_tasks with immediate_fix=true', () => {
    it('should warn when immediate_fix=true but no tasks provided', async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        explanation: 'Critical issue but no tasks defined',
        follow_up_tasks: []
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: 'milestone-123'
      };

      const result = await parser.execute(context);

      expect(result.warnings).toContainEqual(
        expect.stringContaining('PM set immediate_fix=true but provided no tasks')
      );
    });
  });
});
