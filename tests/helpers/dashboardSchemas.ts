import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

export const TaskCreateUpsertSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    external_id: { type: "string" },
    project_id: { type: "string" },
    milestone_id: { type: "string" },
    milestone_slug: { type: "string" },
    parent_task_id: { type: "string" },
    parent_task_external_id: { type: "string" },
    assignee_persona: { type: "string" },
    effort_estimate: { type: "number" },
    priority_score: { type: "number" },
    options: {
      type: "object",
      additionalProperties: true,
      properties: {
        initial_status: { type: "string" },
      },
    },
  },
  required: ["title"],
} as const;

export const TaskStatusUpdateSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { type: "string" },
    lock_version: { type: ["integer", "null"] },
  },
  required: ["status"],
} as const;

export function validate(schema: any, data: any) {
  const v = ajv.compile(schema);
  const ok = v(data);
  return { ok, errors: v.errors };
}
