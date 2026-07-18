import { describe, it, expect } from "vitest";
import {
  buildChangeTasks,
  resolveChangeDependencies,
  changeTaskTypeFromLabels,
  resolveChangeVariables,
} from "../src/workflows/change/changeGrouping";
import { WorkflowSelector } from "../src/workflows/coordinator/WorkflowSelector";

const spec = {
  slug: "openapi-layer",
  title: "OpenAPI layer",
  files: [
    { path: "src/openapi/document.ts", contract: "export const openApiDocument = {...}" },
    {
      path: "src/routes/openapi.ts",
      contract: 'import { openApiDocument } from "../openapi/document";',
      dependsOn: ["src/openapi/document.ts"],
    },
    {
      path: "tests/openapi.test.ts",
      contract: 'import { registerOpenApiRoutes } from "../src/routes/openapi";',
      dependsOn: ["src/routes/openapi.ts"],
    },
  ],
};

describe("buildChangeTasks", () => {
  it("emits a setup, one task per file, and a converge task", () => {
    const built = buildChangeTasks(spec);
    const types = built.tasks.map((t) => t.labels.find((l) => l.startsWith("change_")));
    expect(types).toEqual([
      "change_setup",
      "change_file",
      "change_file",
      "change_file",
      "change_converge",
    ]);
  });

  it("tags every task with the change slug and files with their path", () => {
    const built = buildChangeTasks(spec);
    for (const t of built.tasks) {
      expect(t.labels).toContain("change:openapi-layer");
    }
    const fileTask = built.tasks.find((t) => t.external_id.includes("routes-openapi"));
    expect(fileTask?.labels).toContain("file:src/routes/openapi.ts");
  });

  it("wires file dependencies on setup plus imported siblings, converge on all files", () => {
    const built = buildChangeTasks(spec);
    const routeDeps = built.dependencies["change-openapi-layer-file-src-routes-openapi-ts"];
    expect(routeDeps).toContain("change-openapi-layer-setup");
    expect(routeDeps).toContain("change-openapi-layer-file-src-openapi-document-ts");

    const convergeDeps = built.dependencies["change-openapi-layer-converge"];
    expect(convergeDeps).toHaveLength(3);
    expect(convergeDeps).toContain("change-openapi-layer-file-tests-openapi-test-ts");
  });

  it("rejects an empty change", () => {
    expect(() => buildChangeTasks({ slug: "x", title: "x", files: [] })).toThrow();
  });
});

describe("resolveChangeDependencies", () => {
  it("maps external-id dependencies to created task ids", () => {
    const built = buildChangeTasks(spec);
    const idByExternalId: Record<string, number> = {};
    built.tasks.forEach((t, i) => (idByExternalId[t.external_id] = 100 + i));

    const patches = resolveChangeDependencies(idByExternalId, built.dependencies);
    const convergePatch = patches.find((p) => p.taskId === idByExternalId["change-openapi-layer-converge"]);
    expect(convergePatch?.blocked_dependencies).toHaveLength(3);
    expect(convergePatch?.blocked_dependencies.every((d) => /^\d+$/.test(d))).toBe(true);
  });

  it("skips dependencies whose task was not created", () => {
    const patches = resolveChangeDependencies(
      { "change-x-converge": 5 },
      { "change-x-converge": ["change-x-file-a", "change-x-file-b"] },
    );
    expect(patches).toHaveLength(0);
  });
});

describe("change label helpers", () => {
  it("reads the change task type from labels (array or JSON string)", () => {
    expect(changeTaskTypeFromLabels({ labels: ["change_file", "change:x"] })).toBe("change_file");
    expect(changeTaskTypeFromLabels({ labels: '["change_converge","change:x"]' })).toBe("change_converge");
    expect(changeTaskTypeFromLabels({ labels: ["feature"] })).toBeNull();
  });

  it("resolves the change branch and file sub-branch from labels", () => {
    const vars = resolveChangeVariables({
      labels: ["change_file", "change:openapi-layer", "file:src/routes/openapi.ts"],
    });
    expect(vars?.changeSlug).toBe("openapi-layer");
    expect(vars?.changeBranch).toBe("change/openapi-layer");
    expect(vars?.fileBranch).toBe("change/openapi-layer__src-routes-openapi-ts");
  });

  it("returns no file branch for the setup and converge tasks", () => {
    const vars = resolveChangeVariables({ labels: ["change_setup", "change:openapi-layer"] });
    expect(vars?.changeBranch).toBe("change/openapi-layer");
    expect(vars?.fileBranch).toBeUndefined();
  });

  it("returns null for a non-change task", () => {
    expect(resolveChangeVariables({ labels: ["feature"] })).toBeNull();
  });
});

describe("selector routing (wiring)", () => {
  it("routes a change-labeled task to its change task_type", () => {
    const selector = new WorkflowSelector();
    expect(
      selector.determineTaskType({ title: "x", labels: ["change_file", "change:openapi-layer"] }),
    ).toBe("change_file");
    expect(
      selector.determineTaskType({ title: "x", labels: ["change_converge", "change:openapi-layer"] }),
    ).toBe("change_converge");
  });

  it("does not treat an ordinary task as a change task", () => {
    const selector = new WorkflowSelector();
    const type = selector.determineTaskType({ title: "Add a feature", labels: ["feature"] });
    expect(["change_setup", "change_file", "change_converge"]).not.toContain(type);
  });
});
