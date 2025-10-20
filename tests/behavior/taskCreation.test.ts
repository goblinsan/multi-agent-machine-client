/**
 * Test Group 3: Task Creation Logic - Consolidated Behavior Tests
 * 
 * Based on: docs/test-rationalization/TEST_GROUP_3_TASK_CREATION_LOGIC.md
 * 
 * This test file consolidates behavior from:
 * - tests/qaFailureTaskCreation.integration.test.ts (442 lines)
 * - tests/codeReviewFailureTaskCreation.integration.test.ts (520 lines)
 * - tests/taskPriorityAndRouting.test.ts (687 lines)
 * 
 * Key Validated Behaviors:
 * 1. Priority tiers: QA urgent=1200, Code/Security/DevOps urgent=1000, all deferred=50
 * 2. Routing strategy: critical/high → same milestone, medium/low → backlog milestone
 * 3. Title formatting: 🚨 [Review Type] (urgent) or 📋 [Review Type] (deferred)
 * 4. Duplicate detection: Title match + 50% description overlap → skip creation
 * 5. Parent linking: All follow-up tasks link to original parent task
 * 6. Retry strategy: Exponential backoff (1s/2s/4s), 3 attempts, abort on exhaustion
 * 7. Idempotency: external_id prevents duplicates on workflow re-runs
 * 
 * Implementation Status: ⏳ Tests written, implementation pending Phase 4-5
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BulkTaskCreationStep } from '../../src/workflows/steps/BulkTaskCreationStep.js';
import { makeTempRepo } from '../makeTempRepo.js';

describe('Task Creation Logic', () => {
  let tempDir: string;
  let bulkTaskCreator: BulkTaskCreationStep;

  beforeEach(async () => {
    tempDir = await makeTempRepo();
    bulkTaskCreator = new BulkTaskCreationStep({
      input_variable: 'pm_decision',
      output_variable: 'created_tasks'
    });
  });

  describe('Priority Tier 1: QA Urgent Tasks (Priority 1200)', () => {
    it('should assign priority 1200 to critical QA tasks', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix authentication test failure',
              description: 'Tests failing due to incorrect mock setup',
              priority: 'critical',
              assignee_persona: 'implementation-planner',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456',
        step_id: 'bulk_task_creation'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0]).toMatchObject({
        priority: 1200,
        title: expect.stringContaining('🚨'),
        title: expect.stringContaining('[QA]')
      });
    });

    it('should assign priority 1200 to high priority QA tasks', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Flaky test in payment flow',
              priority: 'high',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].priority).toBe(1200);
    });
  });

  describe('Priority Tier 2: Code/Security/DevOps Urgent Tasks (Priority 1000)', () => {
    it('should assign priority 1000 to critical Code Review tasks', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [Code] Fix critical race condition',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0]).toMatchObject({
        priority: 1000,
        title: expect.stringContaining('[Code]')
      });
    });

    it('should assign priority 1000 to high priority Security tasks', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [Security] Fix XSS vulnerability',
              priority: 'high',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].priority).toBe(1000);
    });

    it('should assign priority 1000 to critical DevOps tasks', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [DevOps] Build failing in CI',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].priority).toBe(1000);
    });
  });

  describe('Priority Tier 3: Deferred Tasks (Priority 50)', () => {
    it('should assign priority 50 to medium priority tasks', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '📋 [Code] Refactor validation logic',
              priority: 'medium',
              milestone_id: 'backlog-milestone'
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0]).toMatchObject({
        priority: 50,
        title: expect.stringContaining('📋'),
        milestone_id: 'backlog-milestone'
      });
    });

    it('should assign priority 50 to low priority tasks', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '📋 [Code] Add JSDoc comments',
              priority: 'low',
              milestone_id: 'backlog-milestone'
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].priority).toBe(50);
    });
  });

  describe('Milestone Routing', () => {
    it('should route critical/high tasks to parent milestone', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Critical test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        parent_milestone_id: 'milestone-123',
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].milestone_id).toBe('milestone-123');
    });

    it('should route medium/low tasks to backlog milestone', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '📋 [Code] Refactor helpers',
              priority: 'low',
              milestone_id: 'backlog-milestone'
            }
          ]
        },
        backlog_milestone_id: 'backlog-milestone',
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].milestone_id).toBe('backlog-milestone');
    });

    it('should handle missing parent milestone (edge case)', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Critical failure',
              priority: 'critical',
              milestone_id: null // Missing!
            }
          ]
        },
        parent_milestone_id: null,
        backlog_milestone_id: 'backlog-milestone',
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      // Should fall back to backlog milestone with warning
      expect(result.context.created_tasks[0].milestone_id).toBe('backlog-milestone');
      expect(result.warnings).toContainEqual(
        expect.stringContaining('Parent milestone not found')
      );
    });
  });

  describe('Title Formatting', () => {
    it('should prefix urgent tasks with 🚨 emoji', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '[QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].title).toMatch(/^🚨/);
    });

    it('should prefix deferred tasks with 📋 emoji', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '[Code] Refactor validation',
              priority: 'low',
              milestone_id: 'backlog-milestone'
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].title).toMatch(/^📋/);
    });

    it('should preserve existing emoji if already present', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      // Should not double-add emoji
      expect(result.context.created_tasks[0].title).not.toMatch(/^🚨🚨/);
    });
  });

  describe('Duplicate Detection', () => {
    it('should skip task creation when title matches existing task', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix authentication test',
              description: 'Tests are failing',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        existing_tasks: [
          {
            id: 'task-999',
            title: '🚨 [QA] Fix authentication test',
            description: 'Tests are failing due to mock setup',
            priority: 1200
          }
        ],
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      // Should not create task (duplicate detected)
      expect(result.context.created_tasks).toHaveLength(0);
      expect(result.context.skipped_tasks).toHaveLength(1);
      expect(result.context.skipped_tasks[0].reason).toBe('duplicate_detected');
    });

    it('should skip task when title + 50% description overlap detected', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [Code] Refactor validation logic',
              description: 'Extract duplicated validation code to shared helper function for reuse',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        existing_tasks: [
          {
            id: 'task-999',
            title: '🚨 [Code] Refactor validation logic',
            description: 'Extract validation code to helper function for better maintainability',
            priority: 1000
          }
        ],
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      // Should detect 50%+ overlap in description
      expect(result.context.skipped_tasks).toHaveLength(1);
      expect(result.context.skipped_tasks[0].overlap_percentage).toBeGreaterThanOrEqual(50);
    });

    it('should create task when description overlap < 50%', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix authentication test',
              description: 'Tests are failing due to incorrect mock setup in CI environment',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        existing_tasks: [
          {
            id: 'task-999',
            title: '🚨 [QA] Fix authentication test',
            description: 'Add new test for OAuth flow',
            priority: 1200
          }
        ],
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      // Should create task (< 50% overlap)
      expect(result.context.created_tasks).toHaveLength(1);
    });
  });

  describe('Parent Linking', () => {
    it('should link all follow-up tasks to parent task', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            },
            {
              title: '🚨 [Code] Fix code issue',
              priority: 'high',
              milestone_id: 'milestone-123'
            }
          ]
        },
        parent_task_id: 'task-456',
        workflow_run_id: 'run-789'
      };

      const result = await bulkTaskCreator.execute(context);

      result.context.created_tasks.forEach(task => {
        expect(task.parent_task_id).toBe('task-456');
      });
    });
  });

  describe('Assignee Logic', () => {
    it('should always assign to implementation-planner', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123',
              assignee_persona: 'tester-qa' // Should be overridden
            }
          ]
        },
        workflow_run_id: 'run-456'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].assignee_persona).toBe('implementation-planner');
    });
  });

  describe('Retry Strategy (Exponential Backoff)', () => {
    it('should retry task creation 3 times with exponential backoff', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456',
        simulate_dashboard_failure: true // Test helper
      };

      const startTime = Date.now();
      const result = await bulkTaskCreator.execute(context);
      const elapsed = Date.now() - startTime;

      // Should attempt 3 times with delays: 1s + 2s + 4s = 7s minimum
      expect(result.retry_attempts).toBe(3);
      expect(elapsed).toBeGreaterThanOrEqual(7000);
      expect(result.status).toBe('failed');
    });

    it('should succeed on retry after transient failure', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456',
        simulate_transient_failure: 2 // Fail first 2 attempts, succeed on 3rd
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.retry_attempts).toBe(3);
      expect(result.status).toBe('completed');
      expect(result.context.created_tasks).toHaveLength(1);
    });
  });

  describe('Partial Failure Handling', () => {
    it('should abort workflow after retry exhaustion on partial success', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            },
            {
              title: '🚨 [Code] Fix code issue',
              priority: 'high',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456',
        simulate_partial_failure: true // First task succeeds, second fails
      };

      const result = await bulkTaskCreator.execute(context);

      // Should create first task, fail on second, abort workflow
      expect(result.context.created_tasks).toHaveLength(1);
      expect(result.abort_workflow).toBe(true);
      expect(result.error).toMatchObject({
        reason: 'Partial task creation failure after retry exhaustion',
        created_count: 1,
        failed_count: 1
      });
    });
  });

  describe('Idempotency (external_id)', () => {
    it('should generate external_id for each task', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456',
        step_id: 'bulk_task_creation'
      };

      const result = await bulkTaskCreator.execute(context);

      expect(result.context.created_tasks[0].external_id).toBe('run-456:bulk_task_creation:0');
    });

    it('should skip task creation if external_id already exists', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456',
        step_id: 'bulk_task_creation',
        existing_tasks: [
          {
            id: 'task-999',
            external_id: 'run-456:bulk_task_creation:0',
            title: '🚨 [QA] Fix test failure'
          }
        ]
      };

      const result = await bulkTaskCreator.execute(context);

      // Should return existing task, not create duplicate
      expect(result.context.created_tasks).toHaveLength(0);
      expect(result.context.skipped_tasks).toHaveLength(1);
      expect(result.context.skipped_tasks[0].reason).toBe('external_id_exists');
      expect(result.context.skipped_tasks[0].existing_task_id).toBe('task-999');
    });

    it('should handle workflow re-run idempotently (no duplicates)', async () => {
      const context = {
        pm_decision: {
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix test failure',
              priority: 'critical',
              milestone_id: 'milestone-123'
            }
          ]
        },
        workflow_run_id: 'run-456', // Same workflow run
        step_id: 'bulk_task_creation',
        is_retry: true,
        existing_tasks: [
          {
            id: 'task-999',
            external_id: 'run-456:bulk_task_creation:0'
          }
        ]
      };

      const result = await bulkTaskCreator.execute(context);

      // On workflow re-run, should detect existing task and skip
      expect(result.context.created_tasks).toHaveLength(0);
      expect(result.context.skipped_tasks[0].reason).toBe('external_id_exists');
    });
  });
});
