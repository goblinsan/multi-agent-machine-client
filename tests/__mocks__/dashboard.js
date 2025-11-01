import { vi } from "vitest";

export const fetchProjectStatus = vi.fn().mockResolvedValue({
  id: "test-project-id",
  name: "Test Project",
  slug: "test-project",
  status: "active",
});

export const fetchProjectStatusDetails = vi.fn().mockResolvedValue({
  tasks: [],
  milestones: [],
  repositories: [{ url: "https://example.com/test-repo.git" }],
});

export const updateTaskStatus = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
});

export const createDashboardTask = vi.fn().mockResolvedValue({
  id: "new-task-123",
  ok: true,
});

export const fetchProjectTasks = vi.fn().mockResolvedValue({
  tasks: [],
});
