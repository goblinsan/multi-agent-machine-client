import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextExtractor } from '../../src/personas/context/ContextExtractor.js';
import { logger } from '../../src/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { cfg } from '../../src/config.js';

describe('ContextExtractor', () => {
  let extractor: ContextExtractor;
  let tempDir: string;

  beforeEach(async () => {
    extractor = new ContextExtractor();
    
    // Create temp directory for artifact tests
    tempDir = path.join(process.cwd(), 'test-temp-' + Date.now());
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  describe('extractUserText', () => {
    it('should prioritize user_text over all other sources', async () => {
      const userText = await extractor.extractUserText({
        persona: 'test',
        workflowId: 'wf-1',
        intent: 'planning',
        payload: {
          user_text: 'Explicit user text',
          task: {
            description: 'Task description',
            title: 'Task title'
          },
          description: 'Payload description'
        }
      });

      expect(userText).toBe('Explicit user text');
    });

    it('should use task description when available', async () => {
      const userText = await extractor.extractUserText({
        persona: 'implementation-planner',
        workflowId: 'wf-1',
        intent: 'planning',
        payload: {
          task: {
            id: 1,
            title: 'Implement feature X',
            description: 'Add feature X with Y functionality',
            type: 'feature',
            scope: 'medium'
          }
        }
      });

      expect(userText).toContain('Task: Implement feature X');
      expect(userText).toContain('Description: Add feature X with Y functionality');
      expect(userText).toContain('Type: feature');
      expect(userText).toContain('Scope: medium');
    });

    it('should use payload.description if no task.description', async () => {
      const userText = await extractor.extractUserText({
        persona: 'test',
        workflowId: 'wf-1',
        intent: 'planning',
        payload: {
          description: 'Simple description from payload'
        }
      });

      expect(userText).toBe('Simple description from payload');
    });

    it('should throw error if task has no description', async () => {
      await expect(
        extractor.extractUserText({
          persona: 'implementation-planner',
          workflowId: 'wf-1',
          intent: 'planning',
          payload: {
            task: {
              id: 5,
              title: 'Task without description'
            }
          }
        })
      ).rejects.toThrow('has no description');
    });

    it('should fallback to intent if no other source available', async () => {
      const userText = await extractor.extractUserText({
        persona: 'test',
        workflowId: 'wf-1',
        intent: 'custom_intent',
        payload: {}
      });

      expect(userText).toBe('custom_intent');
    });
  });

  describe('readArtifactFromGit', () => {
    it('should read artifact from git repo', async () => {
      // Create a fake repo structure
      const repoName = 'test-repo';
      const repoPath = path.join(tempDir, repoName);
      const artifactPath = 'artifacts/plan.md';
      const fullPath = path.join(repoPath, artifactPath);

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, '# Test Plan\n\nThis is a test plan.');

      // Mock cfg.projectBase to use our temp directory
      const originalProjectBase = cfg.projectBase;
      cfg.projectBase = tempDir;

      try {
        const content = await extractor.readArtifactFromGit(
          artifactPath,
          `https://github.com/test/${repoName}.git`
        );

        expect(content).toBe('# Test Plan\n\nThis is a test plan.');
      } finally {
        cfg.projectBase = originalProjectBase;
      }
    });

    it('should throw error if repo URL not provided', async () => {
      await expect(
        extractor.readArtifactFromGit('artifacts/plan.md', undefined)
      ).rejects.toThrow('Repository URL is required');
    });

    it('should throw error if artifact file does not exist', async () => {
      const originalProjectBase = cfg.projectBase;
      cfg.projectBase = tempDir;

      try {
        await expect(
          extractor.readArtifactFromGit(
            'nonexistent/file.md',
            'https://github.com/test/repo.git'
          )
        ).rejects.toThrow('Failed to read artifact');
      } finally {
        cfg.projectBase = originalProjectBase;
      }
    });
  });

  describe('resolveArtifactPath', () => {
    it('should resolve {repo} placeholder', () => {
      const resolved = extractor.resolveArtifactPath(
        'artifacts/{repo}/plan.md',
        {
          repo: 'https://github.com/owner/my-repo.git'
        }
      );

      expect(resolved).toBe('artifacts/my-repo/plan.md');
    });

    it('should resolve {branch} placeholder', () => {
      const resolved = extractor.resolveArtifactPath(
        'artifacts/{branch}/context.md',
        {
          branch: 'feature/new-feature'
        }
      );

      expect(resolved).toBe('artifacts/feature/new-feature/context.md');
    });

    it('should resolve {workflow_id} placeholder', () => {
      const resolved = extractor.resolveArtifactPath(
        'workflows/{workflow_id}/output.json',
        {
          workflow_id: 'wf-12345'
        }
      );

      expect(resolved).toBe('workflows/wf-12345/output.json');
    });

    it('should resolve multiple placeholders', () => {
      const resolved = extractor.resolveArtifactPath(
        '{repo}/{branch}/{workflow_id}/plan.md',
        {
          repo: 'https://github.com/owner/test-repo.git',
          branch: 'main',
          workflow_id: 'wf-abc'
        }
      );

      expect(resolved).toBe('test-repo/main/wf-abc/plan.md');
    });

    it('should keep unresolved placeholders if variable not found', () => {
      const resolved = extractor.resolveArtifactPath(
        'artifacts/{unknown}/plan.md',
        {
          repo: 'test-repo'
        }
      );

      expect(resolved).toBe('artifacts/{unknown}/plan.md');
    });
  });

  describe('extractContext', () => {
    it('should extract all context components', async () => {
      const context = await extractor.extractContext({
        persona: 'implementation-planner',
        workflowId: 'wf-1',
        intent: 'planning',
        payload: {
          task: {
            id: 1,
            title: 'Test task',
            description: 'Test description'
          }
        }
      });

      expect(context.userText).toContain('Test task');
      expect(context.userText).toContain('Test description');
      expect(context.scanSummary).toBeNull();
      expect(context.dashboardContext).toBeNull();
    });
  });

  describe('artifact reading with fallback', () => {
    it('should handle plan_artifact', async () => {
      const repoName = 'test-repo';
      const repoPath = path.join(tempDir, repoName);
      const artifactPath = 'artifacts/plan.md';
      const fullPath = path.join(repoPath, artifactPath);

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, '# Approved Plan\n\nImplement feature.');

      const originalProjectBase = cfg.projectBase;
      cfg.projectBase = tempDir;

      try {
        const userText = await extractor.extractUserText({
          persona: 'lead-engineer',
          workflowId: 'wf-1',
          intent: 'implementation',
          payload: {
            plan_artifact: artifactPath,
            repo: `https://github.com/test/${repoName}.git`
          },
          repo: `https://github.com/test/${repoName}.git`
        });

        expect(userText).toContain('Approved Plan');
        expect(userText).toContain('Implement feature');
      } finally {
        cfg.projectBase = originalProjectBase;
      }
    });

    it('should fallback to intent if artifact reading fails', async () => {
      const userText = await extractor.extractUserText({
        persona: 'test',
        workflowId: 'wf-1',
        intent: 'fallback_intent',
        payload: {
          plan_artifact: 'nonexistent/file.md',
          repo: 'https://github.com/test/repo.git'
        },
        repo: 'https://github.com/test/repo.git'
      });

      // Should fallback to intent when artifact read fails
      expect(userText).toBe('fallback_intent');
    });
  });

  describe('logging behavior', () => {
    it('should log when using task description', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      await extractor.extractUserText({
        persona: 'implementation-planner',
        workflowId: 'wf-1',
        intent: 'planning',
        payload: {
          task: {
            id: 1,
            title: 'Test task',
            description: 'Test description'
          }
        }
      });

      expect(infoSpy).toHaveBeenCalledWith(
        'PersonaConsumer: Using task description',
        expect.objectContaining({
          persona: 'implementation-planner',
          workflowId: 'wf-1',
          hasDescription: true
        })
      );
    });

    it('should log error when task has no description', async () => {
      const errorSpy = vi.spyOn(logger, 'error');

      try {
        await extractor.extractUserText({
          persona: 'implementation-planner',
          workflowId: 'wf-1',
          intent: 'planning',
          payload: {
            task: {
              id: 5,
              title: 'Task without description'
            }
          }
        });
      } catch (error) {
        // Expected to throw
      }

      expect(errorSpy).toHaveBeenCalledWith(
        'PersonaConsumer: CRITICAL - Task has no description',
        expect.objectContaining({
          persona: 'implementation-planner',
          reason: 'Task description is required for planning and implementation'
        })
      );
    });
  });
});
