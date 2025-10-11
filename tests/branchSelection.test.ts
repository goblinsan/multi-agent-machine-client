import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupAllMocks, coordinatorMod, TestProject } from './helpers/mockHelpers.js';
import * as gitUtils from '../src/gitUtils.js';

// Mock Redis client to prevent connection attempts during tests  
vi.mock('../src/redisClient.js', () => ({
  makeRedis: vi.fn().mockResolvedValue({
    xGroupCreate: vi.fn().mockResolvedValue(null),
    xReadGroup: vi.fn().mockResolvedValue([]),
    xAck: vi.fn().mockResolvedValue(null),
    disconnect: vi.fn().mockResolvedValue(null),
    quit: vi.fn().mockResolvedValue(null),
    xRevRange: vi.fn().mockResolvedValue([]),
    xAdd: vi.fn().mockResolvedValue('test-id'),
    exists: vi.fn().mockResolvedValue(1)
  })
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Coordinator branch selection', () => {
  it('uses remote default branch as base and avoids milestone/milestone', async () => {
    // Arrange: Create project with a single task
    const project: TestProject = {
      id: 'proj-2',
      name: 'Demo Project',
      repositories: [{ url: 'https://example/repo.git' }],
      tasks: [{ id: 't-1', name: 'task', status: 'open' }]
    };

    // Set up all mocks using our reusable helper
    const mockHelpers = setupAllMocks(project, []);

    // Customize git mocking for this specific test case
    // Simulate local repo being on a misleading branch
    vi.spyOn(gitUtils, 'getRepoMetadata').mockResolvedValue({ 
      remoteSlug: 'example/repo', 
      currentBranch: 'milestone/milestone', 
      remoteUrl: 'https://example/repo.git' 
    } as any);
    
    // Force remote default to main (should be used instead of local branch)
    vi.spyOn(gitUtils, 'detectRemoteDefaultBranch').mockResolvedValue('main');
    
    // Ensure resolveRepoFromPayload returns a repoRoot
    vi.spyOn(gitUtils, 'resolveRepoFromPayload').mockResolvedValue({ 
      repoRoot: '/tmp/repo', 
      branch: null, 
      remote: 'https://example/repo.git' 
    } as any);

    vi.spyOn(gitUtils, 'describeWorkingTree').mockResolvedValue({
      dirty: false,
      branch: 'milestone/milestone',
      entries: [],
      summary: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        total: 0
      },
      porcelain: []
    } as any);

    // Capture arguments to checkout to assert base branch selection
    const checkoutSpy = vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);

    // Act: Run the coordinator
    const coordinator = new coordinatorMod.WorkflowCoordinator();
    const msg = { workflow_id: 'wf-branch', project_id: 'proj-2' } as any;
    const payload = { repo: 'https://example/repo.git' } as any;
    await coordinator.handleCoordinator({}, msg, payload);

    // Assert: Verify that the checkout used the remote default branch 'main' 
    // instead of the misleading local branch 'milestone/milestone'
    expect(checkoutSpy).toHaveBeenCalled();
    const [repoRoot, baseBranch, newBranch] = checkoutSpy.mock.calls[0] as any[];
    expect(repoRoot).toBe('/tmp/repo');
    expect(baseBranch).toBe('main'); // Should use remote default, not local branch
    expect(newBranch).toBe('feat/task');
  });
});
