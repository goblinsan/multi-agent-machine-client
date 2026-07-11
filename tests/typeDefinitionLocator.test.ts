import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  extractInvalidUnionLiteralUses,
  extractOffendingProperties,
  extractPrimitiveAssignabilityMismatches,
  extractTypeNamesFromDiagnostics,
  locateTypeDefinitionFiles,
  summarizeTypeDefinitions,
} from "../src/workflows/steps/helpers/typeDefinitionLocator";

describe("extractTypeNamesFromDiagnostics", () => {
  it("extracts type names from TS2353 and assignability messages", () => {
    const names = extractTypeNamesFromDiagnostics([
      {
        message:
          "Object literal may only specify known properties, and 'id' does not exist in type 'LogEvent'.",
      },
      {
        reason:
          "Typecheck TS2322 at src/x.ts:4:3 - Type 'string' is not assignable to type 'LogEventType'.",
      },
      {
        message:
          "Type '{ id: string; }' is missing the following properties from type 'BatchedWriterOptions': flushInterval, maxBatchSize",
      },
    ]);

    expect(names).toContain("LogEvent");
    expect(names).toContain("LogEventType");
    expect(names).toContain("BatchedWriterOptions");
  });

  it("filters builtin generics and lowercase identifiers", () => {
    const names = extractTypeNamesFromDiagnostics([
      {
        message:
          "Type 'string[]' is not assignable to type 'Array<Promise<LogEvent>>'.",
      },
      { message: "Property 'x' does not exist on type 'string'." },
    ]);

    expect(names).toEqual(["LogEvent"]);
  });

  it("returns empty for syntax errors", () => {
    expect(
      extractTypeNamesFromDiagnostics([{ message: "';' expected." }]),
    ).toEqual([]);
  });
});

describe("locateTypeDefinitionFiles", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "typedef-"));
    await fs.mkdir(path.join(repo, "src/types"), { recursive: true });
    await fs.mkdir(path.join(repo, "src/__tests__"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "src/types/logEvent.ts"),
      "export interface LogEvent {\n  corrId?: string;\n  ts: string;\n  type: 'log' | 'metric' | 'alert' | 'trace';\n}\nexport type LogEventType = LogEvent['type'];\n",
    );
    await fs.writeFile(
      path.join(repo, "src/other.ts"),
      "export const unrelated = 1;\n",
    );
    await fs.writeFile(
      path.join(repo, "src/__tests__/logEvent.test.ts"),
      "interface LogEvent { fake: true }\n",
    );
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("finds the defining file via the repo scan, skipping tests", async () => {
    const files = await locateTypeDefinitionFiles(
      repo,
      ["LogEvent", "LogEventType"],
      [
        { path: "src/__tests__/logEvent.test.ts" },
        { path: "src/other.ts" },
        { path: "src/types/logEvent.ts" },
      ],
    );

    expect(files).toEqual(["src/types/logEvent.ts"]);
  });

  it("returns empty when nothing matches", async () => {
    expect(
      await locateTypeDefinitionFiles(repo, ["Nonexistent"], [
        { path: "src/other.ts" },
      ]),
    ).toEqual([]);
    expect(await locateTypeDefinitionFiles(repo, [], [])).toEqual([]);
  });

  it("falls back to a bounded filesystem scan when repo scan is missing", async () => {
    const files = await locateTypeDefinitionFiles(
      repo,
      ["LogEvent", "LogEventType"],
      null,
    );

    expect(files).toEqual(["src/types/logEvent.ts"]);
  });

  it("summarizes located definitions with their bodies", async () => {
    const summary = await summarizeTypeDefinitions(
      repo,
      ["src/types/logEvent.ts"],
      ["LogEvent", "LogEventType"],
    );

    expect(summary).toContain("// src/types/logEvent.ts");
    expect(summary).toContain("interface LogEvent");
    expect(summary).toContain("corrId?: string;");
    expect(summary).toContain("'log' | 'metric' | 'alert' | 'trace'");
    expect(summary).toContain("type LogEventType = LogEvent['type'];");
  });
});

describe("extractOffendingProperties", () => {
  it("collects the property names named by TS2353-style errors", () => {
    const properties = extractOffendingProperties([
      {
        message:
          "Object literal may only specify known properties, and 'id' does not exist in type 'LogEvent'.",
      },
      {
        reason:
          "Typecheck TS2339 at src/x.ts:9:20 - Property 'timestamp' does not exist on type 'LogEvent'.",
      },
      { message: "';' expected." },
    ]);

    expect(properties).toEqual(["id", "timestamp"]);
  });
});

describe("extractInvalidUnionLiteralUses", () => {
  it("collects string literals that are not assignable to named union types", () => {
    const literals = extractInvalidUnionLiteralUses([
      {
        message:
          'Type \'"worker_ready"\' is not assignable to type \'LogEventType\'.',
      },
      {
        reason:
          'Typecheck TS2352 at src/x.ts:4:3 - Conversion of type \'"request_started"\' to type \'LogEventType\' may be a mistake because neither type sufficiently overlaps with the other.',
      },
      { message: "Type 'string' is not assignable to type 'number'." },
    ]);

    expect(literals).toEqual([
      { literal: "worker_ready", typeName: "LogEventType" },
      { literal: "request_started", typeName: "LogEventType" },
    ]);
  });
});

describe("extractPrimitiveAssignabilityMismatches", () => {
  it("collects primitive value/type mismatches", () => {
    const mismatches = extractPrimitiveAssignabilityMismatches([
      {
        message: "Type 'number' is not assignable to type 'string'.",
      },
      {
        reason:
          "Typecheck TS2322 at src/x.ts:4:3 - Type 'boolean' is not assignable to type 'number'.",
      },
      {
        message:
          'Type \'"worker_ready"\' is not assignable to type \'LogEventType\'.',
      },
    ]);

    expect(mismatches).toEqual([
      { actualType: "number", expectedType: "string" },
      { actualType: "boolean", expectedType: "number" },
    ]);
  });
});
