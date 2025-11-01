import { describe, it, expect, beforeAll } from "vitest";
import {
  DashboardClient,
  createDashboardClient,
} from "../../src/services/DashboardClient";

describe("DashboardClient Integration", () => {
  let client: DashboardClient;
  const projectId = 1;

  beforeAll(() => {
    client = createDashboardClient({
      baseUrl: "http://localhost:3000",
      timeout: 5000,
    });
  });

  it("should create a single task", async () => {
    const task = await client.createTask(projectId, {
      title: "Integration test task",
      description: "Testing DashboardClient.createTask()",
      status: "open",
      priority: 1000,
      labels: ["test", "integration"],
    });

    expect(task).toBeDefined();
    expect(task.id).toBeGreaterThan(0);
    expect(task.title).toBe("Integration test task");
    expect(task.status).toBe("open");
    expect(task.labels).toEqual(["test", "integration"]);
  });

  it("should bulk create tasks", async () => {
    const result = await client.bulkCreateTasks(projectId, {
      tasks: [
        { title: "Bulk task 1", status: "open", priority: 100 },
        { title: "Bulk task 2", status: "open", priority: 200 },
        { title: "Bulk task 3", status: "open", priority: 300 },
      ],
    });

    expect(result.summary.totalRequested).toBe(3);
    expect(result.summary.created).toBe(3);
    expect(result.created).toHaveLength(3);
    expect(result.created[0].title).toBe("Bulk task 1");
    expect(result.created[1].title).toBe("Bulk task 2");
    expect(result.created[2].title).toBe("Bulk task 3");
  });

  it("should update a task", async () => {
    const created = await client.createTask(projectId, {
      title: "Task to update",
      status: "open",
    });

    const updated = await client.updateTask(projectId, created.id, {
      status: "in_progress",
      labels: ["updated"],
    });

    expect(updated.id).toBe(created.id);
    expect(updated.status).toBe("in_progress");
    expect(updated.labels).toEqual(["updated"]);
  });

  it("should list tasks", async () => {
    const result = await client.listTasks(projectId);

    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("should list tasks with filters", async () => {
    const result = await client.listTasks(projectId, {
      status: "open",
    });

    expect(result.data).toBeDefined();
    expect(result.data.every((t: any) => t.status === "open")).toBe(true);
  });

  it("should get a single task", async () => {
    const created = await client.createTask(projectId, {
      title: "Task to get",
      status: "open",
    });

    const fetched = await client.getTask(projectId, created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe("Task to get");
  });

  it("should handle API errors gracefully", async () => {
    await expect(
      client.createTask(projectId, {
        title: "Invalid task",
        status: "invalid_status" as any,
      }),
    ).rejects.toThrow("Dashboard API error (400)");
  });

  it("should handle bulk create with validation errors", async () => {
    await expect(
      client.bulkCreateTasks(projectId, {
        tasks: [
          { title: "Valid task", status: "open" },
          { title: "Invalid task", status: "invalid" as any },
        ],
      }),
    ).rejects.toThrow("Dashboard API bulk create error");
  });
});
