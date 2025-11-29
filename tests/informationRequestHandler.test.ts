import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import {
  InformationRequestHandler,
  normalizeInformationRequests,
} from "../src/workflows/steps/helpers/InformationRequestHandler.js";
import { cfg } from "../src/config.js";
import { fetch } from "undici";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

const fetchMock = vi.mocked(fetch);

function createMockResponse(bodyText: string) {
  const encoder = new TextEncoder();
  const chunk = encoder.encode(bodyText);
  let consumed = false;
  const reader = {
    read: vi.fn().mockImplementation(() => {
      if (consumed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      consumed = true;
      return Promise.resolve({ value: chunk, done: false });
    }),
  };

  return {
    ok: true,
    status: 200,
    headers: {
      get: vi.fn().mockReturnValue("text/plain"),
    },
    body: {
      getReader: () => reader,
    },
  } as any;
}

describe("InformationRequestHandler HTTP deny list", () => {
  let context: WorkflowContext;
  let handler: InformationRequestHandler;
  let tempRepo: string;

  beforeEach(async () => {
    tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), "info-handler-"));
    const mockTransport: any = {};
    const workflowConfig = { name: "test", version: "1.0", steps: [] };
    context = new WorkflowContext(
      "wf-info",
      "proj-info",
      tempRepo,
      "main",
      workflowConfig,
      mockTransport,
      {},
    );
    handler = new InformationRequestHandler(context);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(createMockResponse("hello world"));

    if (!cfg.informationRequests) {
      cfg.informationRequests = {} as any;
    }
    cfg.informationRequests.denyHosts = [];
    cfg.informationRequests.maxSnippetChars = 8000;
    cfg.informationRequests.maxHttpBytes = 200000;
    cfg.informationRequests.artifactSubdir = ".ma/tasks";
  });

  afterEach(async () => {
    if (tempRepo) {
      await fs.rm(tempRepo, { recursive: true, force: true });
    }
  });

  it("allows HTTP acquisitions when deny list is empty", async () => {
    const result = await handler.fulfillRequests(
      [
        {
          type: "http_get",
          url: "https://example.com/resource",
        },
      ],
      { persona: "context", step: "context", iteration: 1 },
    );

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("success");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/resource",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("blocks hosts declared in the deny list", async () => {
    cfg.informationRequests.denyHosts = ["example.com"];

    const result = await handler.fulfillRequests(
      [
        {
          type: "http_get",
          url: "https://example.com/blocked",
        },
      ],
      { persona: "context", step: "context", iteration: 1 },
    );

    expect(result[0].status).toBe("error");
    expect(result[0].error).toContain("blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists repo_file artifacts when task id is numeric", async () => {
    const relativePath = "src/context.txt";
    const fullPath = path.join(tempRepo, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, "line 1\nline 2\nline 3", "utf8");

    const result = await handler.fulfillRequests(
      [
        {
          type: "repo_file",
          path: relativePath,
          startLine: 1,
          endLine: 2,
        },
      ],
      { persona: "context", step: "context", iteration: 1, taskId: 42 },
    );

    expect(result[0].status).toBe("success");
    expect(result[0].artifactPath).toBeTruthy();
    const artifactPath = path.join(tempRepo, result[0].artifactPath!);
    const artifactData = JSON.parse(await fs.readFile(artifactPath, "utf8"));
    expect(artifactData.metadata.path).toBe(relativePath);
  });

  it("supports GitHub-style line anchors in repo_file paths", async () => {
    const relativePath = "src/plan.md";
    const fullPath = path.join(tempRepo, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(
      fullPath,
      [
        "heading",
        "line two",
        "line three",
        "line four",
      ].join("\n"),
      "utf8",
    );

    const result = await handler.fulfillRequests(
      [
        {
          type: "repo_file",
          path: `${relativePath}#L2-L3`,
        },
      ],
      { persona: "context", step: "context", iteration: 1 },
    );

    expect(result[0].status).toBe("success");
    expect(result[0].contentSnippet).toBe("line two\nline three");
    expect(result[0].metadata?.startLine).toBe(2);
    expect(result[0].metadata?.endLine).toBe(3);
  });

  it("defaults single-line anchors to the requested line", async () => {
    const relativePath = "src/notes.md";
    const fullPath = path.join(tempRepo, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, "alpha\nbeta\ngamma", "utf8");

    const [record] = await handler.fulfillRequests(
      [
        {
          type: "repo_file",
          path: `${relativePath}#L2`,
        },
      ],
      { persona: "context", step: "context", iteration: 1 },
    );

    expect(record.status).toBe("success");
    expect(record.contentSnippet).toBe("beta");
    expect(record.metadata?.startLine).toBe(2);
    expect(record.metadata?.endLine).toBe(2);
  });

  it("serves github.com blob URLs from the local repository", async () => {
    const relativePath = "src/github-local.md";
    const fullPath = path.join(tempRepo, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, "root\nsecond\nthird", "utf8");
    context.setVariable(
      "repo_remote",
      "git@github.com:test-owner/info-handler.git",
    );

    fetchMock.mockClear();
    const [record] = await handler.fulfillRequests(
      [
        {
          type: "http_get",
          url: "https://github.com/test-owner/info-handler/blob/main/src/github-local.md#L2",
        },
      ],
      { persona: "context", step: "context", iteration: 1 },
    );

    expect(record.status).toBe("success");
    expect(record.contentSnippet).toBe("second");
    expect(record.metadata?.startLine).toBe(2);
    expect(record.metadata?.endLine).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("normalizeInformationRequests", () => {
  it("supports repo_file and http_get shorthand fields", () => {
    const normalized = normalizeInformationRequests({
      status: "info_request",
      requests: [
        {
          repo_file: "src/App.tsx",
          reason: "Inspect main component",
        },
        {
          http_get: "https://example.com/docs",
          reason: "Review docs",
        },
      ],
    });

    expect(normalized).toEqual([
      expect.objectContaining({
        type: "repo_file",
        path: "src/App.tsx",
        reason: "Inspect main component",
      }),
      expect.objectContaining({
        type: "http_get",
        url: "https://example.com/docs",
        reason: "Review docs",
      }),
    ]);
  });
});
