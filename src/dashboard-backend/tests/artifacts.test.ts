import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let app: any;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-artifacts-test-"));
  process.env.DATABASE_PATH = path.join(tmpDir, "test.db");

  const { build } = await import("../src/server");
  const { getDb, saveDb } = await import("../src/db/connection");
  const { runMigrations } = await import("../src/db/migrations");

  const db = await getDb();
  runMigrations(db);
  db.run(
    "INSERT INTO projects (name, slug) VALUES ('Artifact Test', 'artifact-test')",
  );
  db.run(
    "INSERT INTO tasks (project_id, title, status) VALUES (1, 'Test task', 'open')",
  );
  saveDb(db);

  app = build();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  const { closeDb } = await import("../src/db/connection");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("artifact routes", () => {
  it("creates an artifact and returns metadata", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects/1/tasks/1/artifacts",
      payload: {
        kind: "plan",
        iteration: 1,
        workflow_id: "wf-abc",
        content: "# Plan Iteration 1\n\nDo the thing.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.kind).toBe("plan");
    expect(body.iteration).toBe(1);
    expect(body.task_id).toBe(1);
    expect(body.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.byte_size).toBeGreaterThan(0);
    expect(body.content).toBeUndefined();
  });

  it("upserts on the same kind and iteration", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects/1/tasks/1/artifacts",
      payload: {
        kind: "plan",
        iteration: 1,
        content: "# Plan Iteration 1 (revised)",
      },
    });

    expect(res.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/projects/1/tasks/1/artifacts?kind=plan",
    });
    const artifacts = list.json().data;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toContain("revised");
  });

  it("treats null iteration as its own upsert slot", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/projects/1/tasks/1/artifacts",
      payload: { kind: "qa", content: '{"status":"fail"}' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/projects/1/tasks/1/artifacts",
      payload: { kind: "qa", content: '{"status":"pass"}' },
    });
    expect(second.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/projects/1/tasks/1/artifacts?kind=qa",
    });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].content).toContain("pass");
  });

  it("returns the latest artifact by iteration when latest=1", async () => {
    await app.inject({
      method: "POST",
      url: "/projects/1/tasks/1/artifacts",
      payload: { kind: "plan", iteration: 3, content: "iteration three" },
    });
    await app.inject({
      method: "POST",
      url: "/projects/1/tasks/1/artifacts",
      payload: { kind: "plan", iteration: 2, content: "iteration two" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/projects/1/tasks/1/artifacts?kind=plan&latest=1",
    });
    const artifacts = res.json().data;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].iteration).toBe(3);
    expect(artifacts[0].content).toBe("iteration three");
  });

  it("omits content when meta_only=1", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/projects/1/tasks/1/artifacts?kind=plan&meta_only=1",
    });
    const artifacts = res.json().data;
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts[0].content).toBeUndefined();
    expect(artifacts[0].content_hash).toBeDefined();
  });

  it("upserts and lists project-scoped artifacts independently of tasks", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/projects/1/artifacts",
      payload: { kind: "context_summary", content: "# Repo summary v1" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().task_id).toBeNull();

    const second = await app.inject({
      method: "POST",
      url: "/projects/1/artifacts",
      payload: { kind: "context_summary", content: "# Repo summary v2" },
    });
    expect(second.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/projects/1/artifacts?kind=context_summary",
    });
    const artifacts = list.json().data;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toContain("v2");

    const taskList = await app.inject({
      method: "GET",
      url: "/projects/1/tasks/1/artifacts?kind=context_summary",
    });
    expect(taskList.json().data).toHaveLength(0);
  });

  it("404s for a project that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects/999/artifacts",
      payload: { kind: "context_summary", content: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s for a task that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects/1/tasks/999/artifacts",
      payload: { kind: "plan", content: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s on an invalid payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects/1/tasks/1/artifacts",
      payload: { kind: "", content: 42 },
    });
    expect(res.statusCode).toBe(400);
  });
});
