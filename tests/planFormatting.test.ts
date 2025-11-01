import { describe, it, expect } from "vitest";

describe("Plan Formatting", () => {
  describe("formatPlanArtifact", () => {
    const formatPlanArtifact = (planResult: any, iteration: number): string => {
      const parseEventResult = (result: string | undefined) => {
        if (!result) return null;
        try {
          return JSON.parse(result);
        } catch {
          return { raw: result };
        }
      };

      const fields = planResult?.fields || {};
      const resultText = fields.result || "";
      const parsed = parseEventResult(resultText);

      let planData = parsed;
      if (parsed?.output && typeof parsed.output === "string") {
        const jsonMatch = parsed.output.match(/```json\s*\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          try {
            planData = JSON.parse(jsonMatch[1]);
          } catch {
            planData = parsed;
          }
        }
      }

      let content = `# Plan Iteration ${iteration}\n\n`;
      content += `Generated: ${new Date().toISOString()}\n\n`;

      if (planData?.plan && Array.isArray(planData.plan)) {
        content += `## Implementation Plan\n\n`;
        planData.plan.forEach((step: any, idx: number) => {
          content += `### Step ${idx + 1}: ${step.goal || "Untitled Step"}\n\n`;
          if (step.key_files && Array.isArray(step.key_files)) {
            content += `**Files:** ${step.key_files.map((f: string) => `\`${f}\``).join(", ")}\n\n`;
          }
          if (step.owners && Array.isArray(step.owners)) {
            content += `**Owners:** ${step.owners.join(", ")}\n\n`;
          }
          if (step.dependencies && Array.isArray(step.dependencies)) {
            content += `**Dependencies:**\n`;
            step.dependencies.forEach((dep: any) => {
              if (typeof dep === "string") {
                content += `  - ${dep}\n`;
              } else if (dep.goal || dep.dependency) {
                content += `  - ${dep.goal || dep.dependency}\n`;
              }
            });
            content += `\n`;
          }
          if (
            step.acceptance_criteria &&
            Array.isArray(step.acceptance_criteria)
          ) {
            content += `**Acceptance Criteria:**\n`;
            step.acceptance_criteria.forEach((ac: string) => {
              content += `  - ${ac}\n`;
            });
            content += `\n`;
          }
        });
      } else {
        const planText =
          typeof planData?.plan === "string" ? planData.plan : resultText;
        if (planText) {
          content += `## Plan\n\n${planText}\n\n`;
        }
      }

      if (
        planData?.risks &&
        Array.isArray(planData.risks) &&
        planData.risks.length > 0
      ) {
        content += `## Risks\n\n`;
        planData.risks.forEach((risk: any, idx: number) => {
          if (typeof risk === "object") {
            content += `${idx + 1}. **${risk.risk || risk.description || "Unknown Risk"}**\n`;
            if (risk.mitigation) {
              content += `   - Mitigation: ${risk.mitigation}\n`;
            }
          } else {
            content += `${idx + 1}. ${risk}\n`;
          }
        });
        content += `\n`;
      }

      if (
        planData?.open_questions &&
        Array.isArray(planData.open_questions) &&
        planData.open_questions.length > 0
      ) {
        content += `## Open Questions\n\n`;
        planData.open_questions.forEach((q: any, idx: number) => {
          if (typeof q === "object") {
            content += `${idx + 1}. ${q.question || q.description || JSON.stringify(q)}\n`;
            if (q.answer) {
              content += `   - Answer: ${q.answer}\n`;
            }
          } else {
            content += `${idx + 1}. ${q}\n`;
          }
        });
        content += `\n`;
      }

      if (
        planData?.notes &&
        Array.isArray(planData.notes) &&
        planData.notes.length > 0
      ) {
        content += `## Notes\n\n`;
        planData.notes.forEach((note: any, idx: number) => {
          if (typeof note === "object") {
            content += `${idx + 1}. ${note.note || note.description || JSON.stringify(note)}\n`;
            if (note.author) {
              content += `   - By: ${note.author}\n`;
            }
          } else {
            content += `${idx + 1}. ${note}\n`;
          }
        });
        content += `\n`;
      }

      if (planData?.metadata) {
        content += `## Metadata\n\n\`\`\`json\n${JSON.stringify(planData.metadata, null, 2)}\n\`\`\`\n`;
      }

      return content;
    };

    it("should handle direct plan JSON structure", () => {
      const planResult = {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Setup project",
                key_files: ["package.json"],
                owners: ["Engineer A"],
                dependencies: [],
                acceptance_criteria: ["Project initialized"],
              },
            ],
          }),
        },
      };

      const result = formatPlanArtifact(planResult, 1);

      expect(result).toContain("# Plan Iteration 1");
      expect(result).toContain("## Implementation Plan");
      expect(result).toContain("### Step 1: Setup project");
      expect(result).toContain("**Files:** `package.json`");
      expect(result).toContain("**Owners:** Engineer A");
      expect(() => formatPlanArtifact(planResult, 1)).not.toThrow();
    });

    it("should handle nested JSON in output field with markdown wrapper", () => {
      const planResult = {
        fields: {
          result: JSON.stringify({
            output: '```json\n{\n  "plan": [\n    {\n      "goal": "Define config structure",\n      "key_files": ["config.ts", "schema.json"],\n      "owners": ["Engineer A"],\n      "dependencies": [],\n      "acceptance_criteria": ["Config structure defined"]\n    }\n  ]\n}\n```',
          }),
        },
      };

      const result = formatPlanArtifact(planResult, 1);

      expect(result).toContain("# Plan Iteration 1");
      expect(result).toContain("## Implementation Plan");
      expect(result).toContain("### Step 1: Define config structure");
      expect(result).toContain("**Files:** `config.ts`, `schema.json`");
      expect(() => formatPlanArtifact(planResult, 1)).not.toThrow();
    });

    it("should handle plan with risks, open_questions, and notes", () => {
      const planResult = {
        fields: {
          result: JSON.stringify({
            output:
              '```json\n{\n  "plan": [{"goal": "Test"}],\n  "risks": [{"risk": "Schema validation may fail", "mitigation": "Review schema regularly"}],\n  "open_questions": [{"question": "How to handle conflicts?", "answer": "TBD"}],\n  "notes": [{"note": "Use python-dotenv", "author": "Engineer A"}]\n}\n```',
          }),
        },
      };

      const result = formatPlanArtifact(planResult, 2);

      expect(result).toContain("# Plan Iteration 2");
      expect(result).toContain("## Implementation Plan");
      expect(result).toContain("## Risks");
      expect(result).toContain("Schema validation may fail");
      expect(result).toContain("Mitigation: Review schema regularly");
      expect(result).toContain("## Open Questions");
      expect(result).toContain("How to handle conflicts?");
      expect(result).toContain("Answer: TBD");
      expect(result).toContain("## Notes");
      expect(result).toContain("Use python-dotenv");
      expect(result).toContain("By: Engineer A");
      expect(() => formatPlanArtifact(planResult, 2)).not.toThrow();
    });

    it("should handle malformed JSON gracefully", () => {
      const planResult = {
        fields: {
          result: JSON.stringify({
            output: '```json\n{\n  "plan": [{"goal": "Test"}\n```',
          }),
        },
      };

      const result = formatPlanArtifact(planResult, 1);

      expect(result).toContain("# Plan Iteration 1");
      expect(() => formatPlanArtifact(planResult, 1)).not.toThrow();
    });

    it("should handle empty plan array", () => {
      const planResult = {
        fields: {
          result: JSON.stringify({
            plan: [],
          }),
        },
      };

      const result = formatPlanArtifact(planResult, 1);

      expect(result).toContain("# Plan Iteration 1");
      expect(result).toContain("## Implementation Plan");
      expect(() => formatPlanArtifact(planResult, 1)).not.toThrow();
    });

    it("should handle plan as string instead of array", () => {
      const planResult = {
        fields: {
          result: JSON.stringify({
            plan: "This is a text plan description",
          }),
        },
      };

      const result = formatPlanArtifact(planResult, 1);

      expect(result).toContain("# Plan Iteration 1");
      expect(result).toContain("## Plan");
      expect(result).toContain("This is a text plan description");
      expect(() => formatPlanArtifact(planResult, 1)).not.toThrow();
    });

    it("should handle missing fields gracefully", () => {
      const planResult = {
        fields: {
          result: JSON.stringify({}),
        },
      };

      const result = formatPlanArtifact(planResult, 1);

      expect(result).toContain("# Plan Iteration 1");
      expect(() => formatPlanArtifact(planResult, 1)).not.toThrow();
    });

    it("should reproduce the actual workflow bug - nested output structure", () => {
      const actualLogData = {
        fields: {
          result: JSON.stringify({
            output:
              '```json\n{\n  "plan": [\n    {\n      "goal": "Define the configuration hierarchy",\n      "key_files": ["config.py", ".env.example"],\n      "owners": ["Engineer A"],\n      "dependencies": [],\n      "acceptance_criteria": [\n        "The config loader loads values from .env file correctly",\n        "The config loader loads values from CLI arguments correctly"\n      ]\n    }\n  ],\n  "risks": [],\n  "open_questions": [],\n  "notes": []\n}\n```',
          }),
        },
      };

      expect(() => formatPlanArtifact(actualLogData, 3)).not.toThrow();

      const result = formatPlanArtifact(actualLogData, 3);

      expect(result).toContain("# Plan Iteration 3");
      expect(result).toContain("## Implementation Plan");
      expect(result).toContain(
        "### Step 1: Define the configuration hierarchy",
      );
      expect(result).toContain("**Files:** `config.py`, `.env.example`");
    });
  });
});
