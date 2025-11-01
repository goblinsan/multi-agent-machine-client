import { describe, it, expect } from "vitest";
import { ConfigResolver } from "../src/workflows/engine/ConfigResolver";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext";

describe("ConfigResolver", () => {
  it("preserves object structure for exact ${variable} matches", () => {
    const resolver = new ConfigResolver();
    const context = new WorkflowContext(
      "test-workflow",
      "test-project",
      "/tmp/repo",
      null as any,
    );

    const taskObject = {
      id: "task-123",
      type: "feature",
      description: "Test task",
      data: { nested: "value" },
    };

    context.setVariable("task", taskObject);

    const config = {
      payload: {
        task: "${task}",
        otherField: "static value",
      },
    };

    const resolved = resolver.resolveConfiguration(config, context);

    expect(resolved.payload.task).toEqual(taskObject);
    expect(resolved.payload.task).toBe(taskObject);
    expect(typeof resolved.payload.task).toBe("object");
    expect(resolved.payload.task.id).toBe("task-123");
    expect(resolved.payload.task).not.toBe("[object Object]");
  });

  it("converts to string for inline variable interpolation", () => {
    const resolver = new ConfigResolver();
    const context = new WorkflowContext(
      "test-workflow",
      "test-project",
      "/tmp/repo",
      null as any,
    );

    context.setVariable("taskId", "task-456");
    context.setVariable("status", "pending");

    const config = {
      message: "Task ${taskId} is ${status}",
    };

    const resolved = resolver.resolveConfiguration(config, context);

    expect(resolved.message).toBe("Task task-456 is pending");
    expect(typeof resolved.message).toBe("string");
  });

  it("handles nested objects with exact matches", () => {
    const resolver = new ConfigResolver();
    const context = new WorkflowContext(
      "test-workflow",
      "test-project",
      "/tmp/repo",
      null as any,
    );

    const complexObject = {
      metadata: { version: "1.0", author: "test" },
      items: [1, 2, 3],
      config: { enabled: true },
    };

    context.setVariable("data", complexObject);

    const config = {
      wrapper: {
        nestedData: "${data}",
        otherProp: "value",
      },
    };

    const resolved = resolver.resolveConfiguration(config, context);

    expect(resolved.wrapper.nestedData).toEqual(complexObject);
    expect(resolved.wrapper.nestedData.metadata.version).toBe("1.0");
    expect(resolved.wrapper.nestedData.items).toEqual([1, 2, 3]);
    expect(Array.isArray(resolved.wrapper.nestedData.items)).toBe(true);
  });

  it("preserves arrays for exact matches", () => {
    const resolver = new ConfigResolver();
    const context = new WorkflowContext(
      "test-workflow",
      "test-project",
      "/tmp/repo",
      null as any,
    );

    const arrayValue = ["item1", "item2", { key: "value" }];
    context.setVariable("list", arrayValue);

    const config = {
      items: "${list}",
    };

    const resolved = resolver.resolveConfiguration(config, context);

    expect(Array.isArray(resolved.items)).toBe(true);
    expect(resolved.items).toEqual(arrayValue);
    expect(resolved.items[2].key).toBe("value");
  });

  it("returns original template string when variable not found", () => {
    const resolver = new ConfigResolver();
    const context = new WorkflowContext(
      "test-workflow",
      "test-project",
      "/tmp/repo",
      null as any,
    );

    const config = {
      missing: "${nonexistent}",
    };

    const resolved = resolver.resolveConfiguration(config, context);

    expect(resolved.missing).toBe("${nonexistent}");
  });

  it("handles multiple variables in same object", () => {
    const resolver = new ConfigResolver();
    const context = new WorkflowContext(
      "test-workflow",
      "test-project",
      "/tmp/repo",
      null as any,
    );

    const task = { id: "t1", type: "bug" };
    const repo = { url: "https://github.com/test/repo", branch: "main" };

    context.setVariable("task", task);
    context.setVariable("repo", repo);
    context.setVariable("projectId", "proj-123");

    const config = {
      payload: {
        task: "${task}",
        repo: "${repo}",
        project: "${projectId}",
      },
    };

    const resolved = resolver.resolveConfiguration(config, context);

    expect(resolved.payload.task).toEqual(task);
    expect(resolved.payload.repo).toEqual(repo);
    expect(resolved.payload.project).toBe("proj-123");
    expect(typeof resolved.payload.task).toBe("object");
    expect(typeof resolved.payload.repo).toBe("object");
  });

  it("regression test: task object should not become [object Object] string", () => {
    const resolver = new ConfigResolver();
    const context = new WorkflowContext(
      "test-workflow",
      "test-project",
      "/tmp/repo",
      null as any,
    );

    const task = {
      id: "task-789",
      type: "feature",
      persona: "lead_engineer",
      data: { description: "Implement feature X" },
      timestamp: Date.now(),
    };

    context.setVariable("task", task);

    const config = {
      payload: {
        task: "${task}",
        repo: "https://github.com/test/repo",
        project_id: "proj-xyz",
      },
    };

    const resolved = resolver.resolveConfiguration(config, context);

    expect(resolved.payload.task).not.toBe("[object Object]");
    expect(typeof resolved.payload.task).toBe("object");
    expect(resolved.payload.task.id).toBe("task-789");

    const stringified = JSON.stringify({ task: resolved.payload.task });
    const parsed = JSON.parse(stringified);

    expect(Object.keys(parsed.task)).toEqual([
      "id",
      "type",
      "persona",
      "data",
      "timestamp",
    ]);
    expect(Object.keys(parsed.task)).not.toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
    ]);
  });
});
