/**
 * Distributed Git Architecture Tests
 * 
 * These tests validate the CRITICAL architectural requirement:
 * "Almost every step pushes to git for distributed agent coordination"
 * 
 * WHY THESE TESTS ARE CRITICAL:
 * - Distributed agents MUST be able to pick up work from git
 * - Context, planning, and review artifacts MUST persist in .ma/ directory
 * - Git commits enable audit trail and failure recovery
 * - Missing git commits = broken distributed architecture
 * 
 * If these tests fail, the distributed architecture is BROKEN.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextStep } from '../src/workflows/steps/ContextStep.js';
import { GitArtifactStep } from '../src/workflows/steps/GitArtifactStep.js';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { makeTempRepo } from './makeTempRepo.js';
import fs from 'fs/promises';
import path from 'path';
import { runGit } from '../src/gitUtils.js';
import { LocalTransport } from '../src/transport/LocalTransport.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execP = promisify(exec);

describe('Distributed Git Architecture - CRITICAL REQUIREMENTS', () => {
  let tempRepoDir: string;
  let transport: LocalTransport;
  let context: WorkflowContext;

  beforeEach(async () => {
    // Create temp repo with initial files
    tempRepoDir = await makeTempRepo({
      'src/example.ts': 'export const hello = "world";',
      'README.md': '# Test Project'
    });

    transport = new LocalTransport();
    await transport.connect();

    // Create workflow context
    context = new WorkflowContext(
      'test-workflow',
      '1',
      tempRepoDir,
      'main',
      { name: 'test', version: '1.0', steps: [] },
      transport,
      {
        task: { id: '1', title: 'Test Task', description: 'Test', type: 'feature' }
      }
    );
  });

  afterEach(async () => {
    await transport.disconnect();
    // Cleanup temp repo
    await execP(`rm -rf ${tempRepoDir}`);
  });

  describe('REQUIREMENT 1: Context scan MUST commit artifacts to git', () => {
    it('should write snapshot.json to .ma/context/', async () => {
      const contextStep = new ContextStep({
        name: 'context_scan',
        type: 'ContextStep',
        config: {
          repoPath: tempRepoDir,
          includePatterns: ['**/*'],
          excludePatterns: ['node_modules/**', '.git/**', '.ma/**']
        }
      });

      const result = await contextStep.execute(context);

      expect(result.status).toBe('success');

      // CRITICAL: snapshot.json MUST exist
      const snapshotPath = path.join(tempRepoDir, '.ma', 'context', 'snapshot.json');
      const snapshotExists = await fs.access(snapshotPath).then(() => true).catch(() => false);
      expect(snapshotExists).toBe(true);

      // Validate snapshot content
      const snapshotContent = await fs.readFile(snapshotPath, 'utf-8');
      const snapshot = JSON.parse(snapshotContent);
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.files).toBeInstanceOf(Array);
      expect(snapshot.files.length).toBeGreaterThan(0);
      expect(snapshot.totals).toBeDefined();
      expect(snapshot.totals.files).toBeGreaterThan(0);
    });

    it('should write summary.md to .ma/context/', async () => {
      const contextStep = new ContextStep({
        name: 'context_scan',
        type: 'ContextStep',
        config: {
          repoPath: tempRepoDir,
          includePatterns: ['**/*'],
          excludePatterns: ['node_modules/**', '.git/**', '.ma/**']
        }
      });

      await contextStep.execute(context);

      // CRITICAL: summary.md MUST exist
      const summaryPath = path.join(tempRepoDir, '.ma', 'context', 'summary.md');
      const summaryExists = await fs.access(summaryPath).then(() => true).catch(() => false);
      expect(summaryExists).toBe(true);

      // Validate summary content
      const summaryContent = await fs.readFile(summaryPath, 'utf-8');
      expect(summaryContent).toContain('# Repository Context Summary');
      expect(summaryContent).toContain('## Statistics');
      expect(summaryContent).toContain('## Directory Structure');
      expect(summaryContent).toContain('## File Types');
    });

    it('should commit context artifacts to git', async () => {
      const contextStep = new ContextStep({
        name: 'context_scan',
        type: 'ContextStep',
        config: {
          repoPath: tempRepoDir,
          includePatterns: ['**/*'],
          excludePatterns: ['node_modules/**', '.git/**', '.ma/**']
        }
      });

      // Get commit count before
      const logBefore = await runGit(['log', '--oneline'], { cwd: tempRepoDir });
      const commitsBefore = logBefore.stdout.trim().split('\n').length;

      await contextStep.execute(context);

      // Get commit count after
      const logAfter = await runGit(['log', '--oneline'], { cwd: tempRepoDir });
      const commitsAfter = logAfter.stdout.trim().split('\n').length;

      // CRITICAL: Must have new commit
      expect(commitsAfter).toBeGreaterThan(commitsBefore);

      // Verify commit message
      const latestCommit = await runGit(['log', '-1', '--pretty=%B'], { cwd: tempRepoDir });
      expect(latestCommit.stdout).toContain('chore(ma): update context scan');
    });

    it('should commit snapshot.json and summary.md in same commit', async () => {
      const contextStep = new ContextStep({
        name: 'context_scan',
        type: 'ContextStep',
        config: {
          repoPath: tempRepoDir,
          includePatterns: ['**/*'],
          excludePatterns: ['node_modules/**', '.git/**', '.ma/**']
        }
      });

      await contextStep.execute(context);

      // Check files in latest commit
      const filesInCommit = await runGit(['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: tempRepoDir });
      const files = filesInCommit.stdout.trim().split('\n').filter(Boolean);

      expect(files).toContain('.ma/context/snapshot.json');
      expect(files).toContain('.ma/context/summary.md');
    });

    it('should NOT commit if context unchanged (reused_existing)', async () => {
      const contextStep = new ContextStep({
        name: 'context_scan',
        type: 'ContextStep',
        config: {
          repoPath: tempRepoDir,
          includePatterns: ['**/*'],
          excludePatterns: ['node_modules/**', '.git/**', '.ma/**']
        }
      });

      // First scan - creates artifacts
      await contextStep.execute(context);
      const logAfterFirst = await runGit(['log', '--oneline'], { cwd: tempRepoDir });
      const commitsAfterFirst = logAfterFirst.stdout.trim().split('\n').length;

      // Second scan without code changes - should reuse
      const result2 = await contextStep.execute(context);
      expect(result2.outputs?.reused_existing).toBe(true);

      const logAfterSecond = await runGit(['log', '--oneline'], { cwd: tempRepoDir });
      const commitsAfterSecond = logAfterSecond.stdout.trim().split('\n').length;

      // CRITICAL: No new commit when reusing context
      expect(commitsAfterSecond).toBe(commitsAfterFirst);
    });

    it('should output repoScan data for context persona', async () => {
      const contextStep = new ContextStep({
        name: 'context_scan',
        type: 'ContextStep',
        config: {
          repoPath: tempRepoDir,
          includePatterns: ['**/*'],
          excludePatterns: ['node_modules/**', '.git/**', '.ma/**']
        }
      });

      const result = await contextStep.execute(context);

      // CRITICAL: repoScan MUST be in outputs for context persona
      expect(result.outputs?.repoScan).toBeDefined();
      expect(result.outputs?.repoScan).toBeInstanceOf(Array);
      expect(result.outputs?.repoScan.length).toBeGreaterThan(0);

      // Verify repoScan structure
      const firstFile = result.outputs?.repoScan[0];
      expect(firstFile).toHaveProperty('path');
      expect(firstFile).toHaveProperty('bytes');
      expect(firstFile).toHaveProperty('mtime');
    });
  });

  describe('REQUIREMENT 2: Reviews MUST commit results to git', () => {
    it('should commit QA review result to .ma/tasks/{id}/reviews/qa.json', async () => {
      context.setVariable('qa_request_result', {
        status: 'pass',
        summary: 'All tests passing',
        findings: []
      });

      const gitArtifactStep = new GitArtifactStep({
        name: 'commit_qa_result',
        type: 'GitArtifactStep',
        config: {
          source_output: 'qa_request_result',
          artifact_path: '.ma/tasks/1/reviews/qa.json',
          commit_message: 'test(ma): QA review for task 1',
          format: 'json'
        }
      });

      const result = await gitArtifactStep.execute(context);
      expect(result.status).toBe('success');

      // CRITICAL: qa.json MUST exist
      const qaPath = path.join(tempRepoDir, '.ma', 'tasks', '1', 'reviews', 'qa.json');
      const qaExists = await fs.access(qaPath).then(() => true).catch(() => false);
      expect(qaExists).toBe(true);

      // CRITICAL: Must be committed
      const filesInCommit = await runGit(['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: tempRepoDir });
      expect(filesInCommit.stdout).toContain('.ma/tasks/1/reviews/qa.json');
    });

    it('should commit code review result to .ma/tasks/{id}/reviews/code-review.json', async () => {
      context.setVariable('code_review_request_result', {
        status: 'pass',
        summary: 'Code looks good',
        findings: { severe: [], high: [], medium: [], low: [] }
      });

      const gitArtifactStep = new GitArtifactStep({
        name: 'commit_code_review_result',
        type: 'GitArtifactStep',
        config: {
          source_output: 'code_review_request_result',
          artifact_path: '.ma/tasks/1/reviews/code-review.json',
          commit_message: 'refactor(ma): code review for task 1',
          format: 'json'
        }
      });

      const result = await gitArtifactStep.execute(context);
      expect(result.status).toBe('success');

      // CRITICAL: code-review.json MUST exist
      const reviewPath = path.join(tempRepoDir, '.ma', 'tasks', '1', 'reviews', 'code-review.json');
      const reviewExists = await fs.access(reviewPath).then(() => true).catch(() => false);
      expect(reviewExists).toBe(true);

      // CRITICAL: Must be committed
      const latestCommit = await runGit(['log', '-1', '--pretty=%B'], { cwd: tempRepoDir });
      expect(latestCommit.stdout).toContain('refactor(ma): code review for task 1');
    });

    it('should commit security review result to .ma/tasks/{id}/reviews/security.json', async () => {
      context.setVariable('security_request_result', {
        status: 'pass',
        summary: 'No vulnerabilities found',
        findings: { severe: [], high: [], medium: [], low: [] }
      });

      const gitArtifactStep = new GitArtifactStep({
        name: 'commit_security_result',
        type: 'GitArtifactStep',
        config: {
          source_output: 'security_request_result',
          artifact_path: '.ma/tasks/1/reviews/security.json',
          commit_message: 'security(ma): security review for task 1',
          format: 'json'
        }
      });

      const result = await gitArtifactStep.execute(context);
      expect(result.status).toBe('success');

      const securityPath = path.join(tempRepoDir, '.ma', 'tasks', '1', 'reviews', 'security.json');
      const securityExists = await fs.access(securityPath).then(() => true).catch(() => false);
      expect(securityExists).toBe(true);
    });

    it('should commit devops review result to .ma/tasks/{id}/reviews/devops.json', async () => {
      context.setVariable('devops_request_result', {
        status: 'pass',
        details: 'CI/CD configured correctly',
        pipeline_status: 'passing'
      });

      const gitArtifactStep = new GitArtifactStep({
        name: 'commit_devops_result',
        type: 'GitArtifactStep',
        config: {
          source_output: 'devops_request_result',
          artifact_path: '.ma/tasks/1/reviews/devops.json',
          commit_message: 'ci(ma): DevOps review for task 1',
          format: 'json'
        }
      });

      const result = await gitArtifactStep.execute(context);
      expect(result.status).toBe('success');

      const devopsPath = path.join(tempRepoDir, '.ma', 'tasks', '1', 'reviews', 'devops.json');
      const devopsExists = await fs.access(devopsPath).then(() => true).catch(() => false);
      expect(devopsExists).toBe(true);
    });
  });

  describe('REQUIREMENT 3: Distributed agent recovery from git', () => {
    it('should allow second agent to read context from git', async () => {
      // First agent scans and commits
      const contextStep = new ContextStep({
        name: 'context_scan',
        type: 'ContextStep',
        config: {
          repoPath: tempRepoDir,
          includePatterns: ['**/*'],
          excludePatterns: ['node_modules/**', '.git/**', '.ma/**']
        }
      });
      await contextStep.execute(context);

      // Second agent reads from git (simulated by reading file directly)
      const snapshotPath = path.join(tempRepoDir, '.ma', 'context', 'snapshot.json');
      const snapshotContent = await fs.readFile(snapshotPath, 'utf-8');
      const snapshot = JSON.parse(snapshotContent);

      // CRITICAL: Second agent can reconstruct context from git
      expect(snapshot.files).toBeInstanceOf(Array);
      expect(snapshot.totals.files).toBeGreaterThan(0);
      expect(snapshot.timestamp).toBeDefined();
    });

    it('should allow second agent to read review results from git', async () => {
      // First agent commits QA result
      context.setVariable('qa_request_result', {
        status: 'fail',
        summary: 'Tests failing',
        findings: ['Test case 1 failed']
      });

      const gitArtifactStep = new GitArtifactStep({
        name: 'commit_qa_result',
        type: 'GitArtifactStep',
        config: {
          source_output: 'qa_request_result',
          artifact_path: '.ma/tasks/1/reviews/qa.json',
          commit_message: 'test(ma): QA review for task 1',
          format: 'json'
        }
      });
      await gitArtifactStep.execute(context);

      // Second agent reads from git
      const qaPath = path.join(tempRepoDir, '.ma', 'tasks', '1', 'reviews', 'qa.json');
      const qaContent = await fs.readFile(qaPath, 'utf-8');
      const qaResult = JSON.parse(qaContent);

      // CRITICAL: Second agent can see QA status and act on it
      expect(qaResult.status).toBe('fail');
      expect(qaResult.summary).toBe('Tests failing');
      expect(qaResult.findings).toContain('Test case 1 failed');
    });
  });

  describe('REQUIREMENT 4: Workflow definitions use correct step types', () => {
    it('task-flow.yaml should use ContextStep not PersonaRequestStep for scanning', async () => {
      const workflowPath = path.join(process.cwd(), 'src', 'workflows', 'definitions', 'task-flow.yaml');
      const workflowContent = await fs.readFile(workflowPath, 'utf-8');

      // CRITICAL: Must use ContextStep for context_scan
      expect(workflowContent).toContain('name: context_scan');
      expect(workflowContent).toContain('type: ContextStep');

      // Should still have context_request for persona analysis
      expect(workflowContent).toContain('name: context_request');
      expect(workflowContent).toContain('type: PersonaRequestStep');
    });

    it('task-flow.yaml should have GitArtifactStep after each review', async () => {
      const workflowPath = path.join(process.cwd(), 'src', 'workflows', 'definitions', 'task-flow.yaml');
      const workflowContent = await fs.readFile(workflowPath, 'utf-8');

      // CRITICAL: Must commit all review results
      expect(workflowContent).toContain('name: commit_qa_result');
      expect(workflowContent).toContain('name: commit_code_review_result');
      expect(workflowContent).toContain('name: commit_security_result');
      expect(workflowContent).toContain('name: commit_devops_result');

      // All should use GitArtifactStep
      const qaCommitMatch = workflowContent.match(/name: commit_qa_result[\s\S]*?type: (\w+)/);
      expect(qaCommitMatch?.[1]).toBe('GitArtifactStep');
    });

    it('in-review-task-flow.yaml should have GitArtifactStep after each review', async () => {
      const workflowPath = path.join(process.cwd(), 'src', 'workflows', 'definitions', 'in-review-task-flow.yaml');
      const workflowContent = await fs.readFile(workflowPath, 'utf-8');

      // CRITICAL: Resume workflow must also commit reviews
      expect(workflowContent).toContain('name: commit_code_review_result');
      expect(workflowContent).toContain('name: commit_security_result');
      expect(workflowContent).toContain('name: commit_devops_result');
    });

    it('context persona should receive repoScan in payload', async () => {
      const workflowPath = path.join(process.cwd(), 'src', 'workflows', 'definitions', 'task-flow.yaml');
      const workflowContent = await fs.readFile(workflowPath, 'utf-8');

      // CRITICAL: Context persona must receive scan data
      const contextRequestSection = workflowContent.match(/name: context_request[\s\S]*?payload:([\s\S]*?)(?=\n {2}#|\n {2}-)/);
      expect(contextRequestSection).toBeDefined();
      expect(contextRequestSection?.[0]).toContain('repoScan');
      expect(contextRequestSection?.[0]).toContain('context_metadata');
      expect(contextRequestSection?.[0]).toContain('reused_existing');
    });
  });

  describe('REQUIREMENT 5: Audit trail and recovery', () => {
    it('should have complete git history for workflow execution', async () => {
      // Simulate full workflow: context → planning → implementation → reviews
      
      // 1. Context scan
      const contextStep = new ContextStep({
        name: 'context_scan',
        type: 'ContextStep',
        config: {
          repoPath: tempRepoDir,
          includePatterns: ['**/*'],
          excludePatterns: ['node_modules/**', '.git/**', '.ma/**']
        }
      });
      await contextStep.execute(context);

      // 2. QA review
      context.setVariable('qa_request_result', { status: 'pass' });
      const qaStep = new GitArtifactStep({
        name: 'commit_qa_result',
        type: 'GitArtifactStep',
        config: {
          source_output: 'qa_request_result',
          artifact_path: '.ma/tasks/1/reviews/qa.json',
          commit_message: 'test(ma): QA review for task 1',
          format: 'json'
        }
      });
      await qaStep.execute(context);

      // 3. Code review
      context.setVariable('code_review_request_result', { status: 'pass' });
      const codeStep = new GitArtifactStep({
        name: 'commit_code_review_result',
        type: 'GitArtifactStep',
        config: {
          source_output: 'code_review_request_result',
          artifact_path: '.ma/tasks/1/reviews/code-review.json',
          commit_message: 'refactor(ma): code review for task 1',
          format: 'json'
        }
      });
      await codeStep.execute(context);

      // Verify git log shows complete history
      const log = await runGit(['log', '--oneline', '--all'], { cwd: tempRepoDir });
      const commits = log.stdout.trim().split('\n');

      // CRITICAL: Should have commits for context, QA, code review
      expect(commits.length).toBeGreaterThanOrEqual(3);
      expect(log.stdout).toContain('context scan');
      expect(log.stdout).toContain('QA review');
      expect(log.stdout).toContain('code review');
    });

    it('should allow rebuilding workflow state from .ma/ directory', async () => {
      // Create complete .ma/ structure
      const contextStep = new ContextStep({
        name: 'context_scan',
        type: 'ContextStep',
        config: {
          repoPath: tempRepoDir,
          includePatterns: ['**/*'],
          excludePatterns: ['node_modules/**', '.git/**', '.ma/**']
        }
      });
      await contextStep.execute(context);

      context.setVariable('qa_request_result', { status: 'pass', summary: 'Tests passing' });
      const qaStep = new GitArtifactStep({
        name: 'commit_qa_result',
        type: 'GitArtifactStep',
        config: {
          source_output: 'qa_request_result',
          artifact_path: '.ma/tasks/1/reviews/qa.json',
          commit_message: 'test(ma): QA review',
          format: 'json'
        }
      });
      await qaStep.execute(context);

      // Verify .ma/ directory structure
      const maPath = path.join(tempRepoDir, '.ma');
      const contextPath = path.join(maPath, 'context');
      const reviewsPath = path.join(maPath, 'tasks', '1', 'reviews');

      const contextExists = await fs.access(contextPath).then(() => true).catch(() => false);
      const reviewsExists = await fs.access(reviewsPath).then(() => true).catch(() => false);

      expect(contextExists).toBe(true);
      expect(reviewsExists).toBe(true);

      // Verify all artifacts present
      const snapshotExists = await fs.access(path.join(contextPath, 'snapshot.json')).then(() => true).catch(() => false);
      const summaryExists = await fs.access(path.join(contextPath, 'summary.md')).then(() => true).catch(() => false);
      const qaExists = await fs.access(path.join(reviewsPath, 'qa.json')).then(() => true).catch(() => false);

      expect(snapshotExists).toBe(true);
      expect(summaryExists).toBe(true);
      expect(qaExists).toBe(true);
    });
  });
});
