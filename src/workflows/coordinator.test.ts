
import { handleCoordinator } from "./coordinator";
import { beforeEach, describe, it, vi } from "vitest";
import * as gitUtils from "../gitUtils";
import * as persona from "../agents/persona";

vi.mock("undici", async () => {
  const undici = await vi.importActual("undici");
  return {
    ...undici,
    fetch: vi.fn(),
  };
});

describe("Agent Workflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should run without errors", async () => {
    const { fetch } = await import("undici");

    // Mock the Redis client
    const redisMock = {
      xReadGroup: vi.fn().mockResolvedValue(null),
      xGroupCreate: vi.fn().mockResolvedValue(null),
      xAdd: vi.fn().mockResolvedValue(null),
      xAck: vi.fn().mockResolvedValue(null),
    };

    // Mock the dashboard API
  (fetch as any).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        id: "project-1",
        name: "Test Project",
        slug: "test-project",
        repository: {
          url: "https://github.com/test/test-project.git",
        },
        milestones: [
          {
            id: "milestone-1",
            name: "Test Milestone",
            slug: "test-milestone",
            tasks: [
              {
                id: "task-1",
                name: "Test Task",
                slug: "test-task",
              },
            ],
          },
        ],
        suggestions: [],
      }),
    });

    const msg = {
      workflow_id: "workflow-1",
      project_id: "project-1",
    };

    const payloadObj = {
      project_id: "project-1",
    };

    vi.spyOn(gitUtils, "resolveRepoFromPayload").mockResolvedValue({
      repoRoot: "/test/repo",
      remote: "https://github.com/test/test-project.git",
      branch: "main",
      source: "payload_repo"
    } as any);

    vi.spyOn(gitUtils, "checkoutBranchFromBase").mockResolvedValue(undefined);
    vi.spyOn(persona, "waitForPersonaCompletion").mockResolvedValue({
      id: "event-1",
      fields: {
        result: JSON.stringify({ success: true }),
      },
    });

    await handleCoordinator(redisMock, msg, payloadObj);
  });
});
