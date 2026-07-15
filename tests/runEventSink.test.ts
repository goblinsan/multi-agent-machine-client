import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  NoopRunEventSink,
  FileRunEventSink,
  DashboardRunEventSink,
} from "../src/runs/RunEventSink";

describe("NoopRunEventSink", () => {
  it("returns a null handle and never throws", async () => {
    const sink = new NoopRunEventSink();
    const handle = await sink.startRun({ projectId: "1", externalId: "wf-1" });
    expect(handle.runId).toBeNull();
    await expect(
      sink.emit(handle.runId, { eventId: "e", eventType: "x" }),
    ).resolves.toBeUndefined();
    await expect(
      sink.completeRun(handle.runId, { status: "completed" }),
    ).resolves.toBeUndefined();
  });
});

describe("FileRunEventSink", () => {
  it("writes start, event, and complete records as JSON lines", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-events-"));
    const file = path.join(dir, "events.log");
    const sink = new FileRunEventSink(file);

    const handle = await sink.startRun({
      projectId: "1",
      externalId: "wf-file",
      workflowType: "orchestrate_milestone",
    });
    expect(handle.runId).toBe("wf-file");

    await sink.emit(handle.runId, {
      eventId: "e1",
      eventType: "task_started",
      stepName: "task:7",
    });
    await sink.completeRun(handle.runId, {
      status: "completed",
      metadata: { tasksProcessed: 1 },
    });

    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual([
      "run_start",
      "run_event",
      "run_complete",
    ]);
    expect(lines[1].runId).toBe("wf-file");
    expect(lines[2].status).toBe("completed");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("DashboardRunEventSink resilience", () => {
  it("returns a null handle when the dashboard is unreachable and never throws", async () => {
    const sink = new DashboardRunEventSink();
    const handle = await sink.startRun({
      projectId: "1",
      externalId: "wf-unreachable",
    });
    expect(handle.runId).toBeNull();
    await expect(
      sink.emit(handle.runId, { eventId: "e", eventType: "x" }),
    ).resolves.toBeUndefined();
    await expect(
      sink.completeRun(handle.runId, { status: "failed" }),
    ).resolves.toBeUndefined();
  });
});
