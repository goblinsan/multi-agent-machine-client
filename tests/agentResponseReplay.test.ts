import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { parseAgentEditsFromResponse } from "../src/workflows/helpers/agentResponseParser";
import { parseUnifiedDiffToEditSpec } from "../src/fileops";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixturePath = path.join(
  __dirname,
  "fixtures/personaOutputs/lead_engineer_previews.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

describe("agent diff replay (lead-engineer persona)", () => {
  for (const testCase of fixture.cases) {
    const label = testCase.label || "case";
    const minOps = typeof testCase.minOps === "number" ? testCase.minOps : 1;

    it(`parses diff bundle for ${label}`, async () => {
      const parseOutcome = await parseAgentEditsFromResponse(testCase.input, {
        parseDiff: (diff: string) => parseUnifiedDiffToEditSpec(diff),
        maxDiffCandidates: 12,
      });

      const editSpec =
        parseOutcome.editSpec && typeof parseOutcome.editSpec === "object"
          ? parseOutcome.editSpec
          : { ops: [] };
      const ops = Array.isArray((editSpec as any).ops)
        ? (editSpec as any).ops
        : [];

      expect(ops.length).toBeGreaterThanOrEqual(minOps);
      expect(parseOutcome.diffCandidates.length).toBeGreaterThan(0);
      expect(
        parseOutcome.source === "structured" || parseOutcome.source === "diff",
      ).toBe(true);
    });
  }
});
