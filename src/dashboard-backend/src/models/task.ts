import { z } from "zod";

export const taskCreateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  milestone_id: z.number().int().positive().optional(),
  parent_task_id: z.number().int().positive().optional(),
  status: z
    .enum(["open", "in_progress", "in_review", "blocked", "done", "archived"])
    .default("open"),
  priority_score: z.number().int().min(0).max(10000).optional().default(0),
  external_id: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

export type TaskCreate = z.infer<typeof taskCreateSchema>;
