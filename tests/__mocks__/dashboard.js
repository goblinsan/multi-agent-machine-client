/**
 * Mock implementation of dashboard module for testing.
 * 
 * Vitest/Jest automatically uses this mock when vi.mock('../src/dashboard.js') is called
 * without a factory function. This provides sensible defaults for dashboard API calls.
 * 
 * Usage in test files:
 *   vi.mock('../src/dashboard.js');  // Uses this mock with default values
 * 
 * To override specific values in a test:
 *   import * as dashboard from '../src/dashboard.js';
 *   vi.mocked(dashboard.fetchProjectStatus).mockResolvedValueOnce({ id: 'custom-id', ... });
 * 
 * Note: Tests that need significantly different mock behavior should use inline vi.mock()
 * with a factory function instead.
 */
import { vi } from 'vitest';

export const fetchProjectStatus = vi.fn().mockResolvedValue({
  id: 'test-project-id',
  name: 'Test Project',
  slug: 'test-project',
  status: 'active'
});

export const fetchProjectStatusDetails = vi.fn().mockResolvedValue({
  tasks: [],
  milestones: [],
  repositories: [{ url: 'https://example.com/test-repo.git' }]
});

export const updateTaskStatus = vi.fn().mockResolvedValue({
  ok: true,
  status: 200
});

export const createDashboardTask = vi.fn().mockResolvedValue({
  id: 'new-task-123',
  ok: true
});

export const fetchProjectTasks = vi.fn().mockResolvedValue({
  tasks: []
});
