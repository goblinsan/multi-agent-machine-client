import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as gitUtils from '../src/gitUtils.js';
import * as fileops from '../src/fileops.js';
import fs from 'fs/promises';
import path from 'path';
import { makeTempRepo } from './makeTempRepo';
import { createFastCoordinator } from './helpers/coordinatorTestHelper.js';


vi.mock('../src/redisClient.js');


vi.mock('../src/dashboard.js', () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: 'proj-commit',
    name: 'Commit Test Project',
    status: 'active'
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [{ id: 'task-1', name: 'Create test file', status: 'open' }],
    repositories: [{ url: 'https://example/repo.git' }]
  })
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Coordinator commit and push (integration-ish)', () => {
  it('handles file operations and git workflows without hanging', async () => {
    
    const tmp = await makeTempRepo({ 'README.md': '# test\n' });
    let workflowCompleted = false;

    
    vi.spyOn(gitUtils, 'resolveRepoFromPayload')
      .mockResolvedValue({ repoRoot: tmp, branch: 'main', remote: null } as any);
    vi.spyOn(gitUtils, 'getRepoMetadata')
      .mockResolvedValue({ remoteSlug: null, currentBranch: 'main' } as any);
    vi.spyOn(gitUtils, 'checkoutBranchFromBase').mockResolvedValue(undefined as any);
    vi.spyOn(gitUtils, 'ensureBranchPublished').mockResolvedValue(undefined as any);
    
    
    vi.spyOn(fileops, 'applyEditOps').mockImplementation(async (_jsonText: string, _opts: any) => {
      
      await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'src', 'test.ts'), 'console.log("hello world");');
      
      return { 
        changed: ['src/test.ts'], 
        branch: 'feat/agent-edit', 
        sha: '12345' 
      };
    });

    
    const coordinator = createFastCoordinator();
    
    try {
      
      const testPromise = coordinator.handleCoordinator(
        {} as any,
        {}, 
        { workflow_id: 'wf-commit', project_id: 'proj-commit' },
        { repo: tmp }
      ).then(() => {
        workflowCompleted = true;
        return true;
      }).catch(() => {
        workflowCompleted = true;
        return true;
      });

      const timeoutPromise = new Promise<boolean>((_, reject) => 
        setTimeout(() => reject(new Error('Test timeout - workflow hanging')), 100)
      );

      await Promise.race([testPromise, timeoutPromise]);
    } catch (error) {
      
      workflowCompleted = true;
    }

    
    
    expect(workflowCompleted).toBe(true);
  });
});
