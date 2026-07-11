import type { ResponseFormat } from "../lmstudio.js";

const STATUS_ENUM = { type: "string", enum: ["pass", "fail"] };

const reviewFindingSchema = (issueField: string, extraProps: Record<string, unknown> = {}) => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      file: { type: "string" },
      line: { type: "integer" },
      [issueField]: { type: "string" },
      recommendation: { type: "string" },
      ...extraProps,
    },
    required: ["file", issueField],
    additionalProperties: false,
  },
});

const PERSONA_SCHEMAS: Record<string, Record<string, unknown>> = {
  "plan-evaluator": {
    type: "object",
    properties: {
      status: STATUS_ENUM,
      reason: { type: "string" },
    },
    required: ["status"],
    additionalProperties: false,
  },

  "tester-qa": {
    type: "object",
    properties: {
      status: STATUS_ENUM,
      summary: { type: "string" },
      details: { type: "string" },
      root_causes: { type: "array", items: { type: "string" } },
      recommendations: { type: "array", items: { type: "string" } },
      required_files: { type: "array", items: { type: "string" } },
      tdd_red_phase_detected: { type: "boolean" },
    },
    required: ["status", "summary"],
    additionalProperties: false,
  },

  "code-reviewer": {
    type: "object",
    properties: {
      status: STATUS_ENUM,
      summary: { type: "string" },
      findings: {
        type: "object",
        properties: {
          severe: reviewFindingSchema("issue"),
          high: reviewFindingSchema("issue"),
          medium: reviewFindingSchema("issue"),
          low: reviewFindingSchema("issue"),
        },
        required: ["severe", "high", "medium", "low"],
        additionalProperties: false,
      },
    },
    required: ["status", "summary", "findings"],
    additionalProperties: false,
  },

  "security-review": {
    type: "object",
    properties: {
      status: STATUS_ENUM,
      summary: { type: "string" },
      findings: {
        type: "object",
        properties: {
          severe: reviewFindingSchema("vulnerability", {
            category: { type: "string" },
            impact: { type: "string" },
            mitigation: { type: "string" },
          }),
          high: reviewFindingSchema("vulnerability", {
            category: { type: "string" },
            impact: { type: "string" },
            mitigation: { type: "string" },
          }),
          medium: reviewFindingSchema("vulnerability", {
            category: { type: "string" },
            impact: { type: "string" },
            mitigation: { type: "string" },
          }),
          low: reviewFindingSchema("vulnerability", {
            category: { type: "string" },
            impact: { type: "string" },
            mitigation: { type: "string" },
          }),
        },
        required: ["severe", "high", "medium", "low"],
        additionalProperties: false,
      },
    },
    required: ["status", "summary", "findings"],
    additionalProperties: false,
  },

  "implementation-planner": {
    type: "object",
    properties: {
      plan: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            goal: { type: "string", maxLength: 300 },
            key_files: {
              type: "array",
              maxItems: 10,
              items: { type: "string" },
            },
            owners: { type: "array", maxItems: 4, items: { type: "string" } },
            dependencies: {
              type: "array",
              maxItems: 8,
              items: { type: "string" },
            },
            acceptance_criteria: {
              type: "array",
              maxItems: 6,
              items: { type: "string" },
            },
          },
          required: ["goal", "key_files"],
          additionalProperties: false,
        },
      },
      risks: { type: "array", maxItems: 8, items: { type: "string" } },
      open_questions: {
        type: "array",
        maxItems: 6,
        items: { type: "string" },
      },
      notes: { type: "array", maxItems: 8, items: { type: "string" } },
    },
    required: ["plan"],
    additionalProperties: false,
  },
};

export function getPersonaResponseFormat(
  persona: string,
): ResponseFormat | undefined {
  const schema = PERSONA_SCHEMAS[persona];
  if (!schema) return undefined;
  return {
    type: "json_schema",
    json_schema: {
      name: `${persona.replace(/[^a-zA-Z0-9_]/g, "_")}_response`,
      strict: true,
      schema,
    },
  };
}

export function personasWithSchemas(): string[] {
  return Object.keys(PERSONA_SCHEMAS);
}
