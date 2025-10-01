import { z } from "zod";

export const RequestSchema = z.object({
  workflow_id: z.string(),
  step: z.string().optional(),
  from: z.string(),
  to_persona: z.string(),
  intent: z.string(),
  payload: z.string().optional(),
  corr_id: z.string().optional(),
  deadline_s: z.coerce.number().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  project_id: z.string().optional()
});
export type RequestMsg = z.infer<typeof RequestSchema>;

export const EventSchema = z.object({
  workflow_id: z.string(),
  step: z.string().optional(),
  from_persona: z.string(),
  status: z.enum(["done","progress","error","blocked"]),
  result: z.string().optional(),
  corr_id: z.string().optional(),
  ts: z.string().optional(),
  error: z.string().optional()
});
export type EventMsg = z.infer<typeof EventSchema>;
