import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
import { getDb, saveDb } from "../db/connection";

const artifactUpsertSchema = z.object({
  kind: z.string().min(1).max(64),
  content: z.string(),
  iteration: z.number().int().nonnegative().nullable().optional(),
  workflow_id: z.string().max(128).nullable().optional(),
});

const ARTIFACT_COLUMNS =
  "id, project_id, task_id, workflow_id, kind, iteration, content, content_hash, byte_size, created_at, updated_at";

function rowToArtifact(row: any[], includeContent: boolean) {
  const artifact: Record<string, unknown> = {
    id: row[0],
    project_id: row[1],
    task_id: row[2],
    workflow_id: row[3],
    kind: row[4],
    iteration: row[5],
    content_hash: row[7],
    byte_size: row[8],
    created_at: row[9],
    updated_at: row[10],
  };
  if (includeContent) {
    artifact.content = row[6];
  }
  return artifact;
}

export function registerArtifactRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/projects/:projectId/artifacts",
    async (request: any, reply: any) => {
      const projectId = parseInt(request.params.projectId, 10);
      if (!Number.isInteger(projectId)) {
        return reply.code(400).send({ error: "Invalid project id" });
      }

      const validation = artifactUpsertSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.code(400).send({ error: validation.error.issues });
      }

      const db = await getDb();

      const projectCheck = db.exec("SELECT id FROM projects WHERE id = ?", [
        projectId,
      ]);
      if (!projectCheck.length || !projectCheck[0].values.length) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const { kind, content, iteration = null, workflow_id = null } =
        validation.data;
      const contentHash = createHash("sha256").update(content).digest("hex");
      const byteSize = Buffer.byteLength(content, "utf8");

      try {
        const existing = db.exec(
          `SELECT id FROM artifacts
           WHERE project_id = ? AND task_id IS NULL AND kind = ?
             AND COALESCE(iteration, -1) = COALESCE(?, -1)`,
          [projectId, kind, iteration],
        );

        let artifactId: number;
        let created = false;

        if (existing.length && existing[0].values.length) {
          artifactId = existing[0].values[0][0] as number;
          db.run(
            `UPDATE artifacts
             SET content = ?, content_hash = ?, byte_size = ?, workflow_id = ?,
                 updated_at = datetime('now')
             WHERE id = ?`,
            [content, contentHash, byteSize, workflow_id, artifactId],
          );
        } else {
          db.run(
            `INSERT INTO artifacts
             (project_id, task_id, workflow_id, kind, iteration, content, content_hash, byte_size)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
            [
              projectId,
              workflow_id,
              kind,
              iteration,
              content,
              contentHash,
              byteSize,
            ],
          );
          artifactId = db.exec("SELECT last_insert_rowid()")[0]
            .values[0][0] as number;
          created = true;
        }

        await saveDb(db);

        const result = db.exec(
          `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`,
          [artifactId],
        );
        const artifact = rowToArtifact(result[0].values[0], false);

        return reply.code(created ? 201 : 200).send(artifact);
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    },
  );

  fastify.get(
    "/projects/:projectId/artifacts",
    async (request: any, reply: any) => {
      const projectId = parseInt(request.params.projectId, 10);
      if (!Number.isInteger(projectId)) {
        return reply.code(400).send({ error: "Invalid project id" });
      }

      const { kind, latest, meta_only } = request.query || {};
      const db = await getDb();

      const clauses = ["project_id = ?", "task_id IS NULL"];
      const params: any[] = [projectId];
      if (kind) {
        clauses.push("kind = ?");
        params.push(String(kind));
      }

      const limitClause = latest === "1" || latest === "true" ? "LIMIT 1" : "";
      const result = db.exec(
        `SELECT ${ARTIFACT_COLUMNS} FROM artifacts
         WHERE ${clauses.join(" AND ")}
         ORDER BY COALESCE(iteration, -1) DESC, updated_at DESC, id DESC
         ${limitClause}`,
        params,
      );

      if (!result.length) {
        return reply.send({ data: [] });
      }

      const includeContent = !(meta_only === "1" || meta_only === "true");
      const artifacts = result[0].values.map((row) =>
        rowToArtifact(row, includeContent),
      );

      return reply.send({ data: artifacts });
    },
  );

  fastify.post(
    "/projects/:projectId/tasks/:taskId/artifacts",
    async (request: any, reply: any) => {
      const projectId = parseInt(request.params.projectId, 10);
      const taskId = parseInt(request.params.taskId, 10);
      if (!Number.isInteger(projectId) || !Number.isInteger(taskId)) {
        return reply.code(400).send({ error: "Invalid project or task id" });
      }

      const validation = artifactUpsertSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.code(400).send({ error: validation.error.issues });
      }

      const db = await getDb();

      const taskCheck = db.exec(
        "SELECT id FROM tasks WHERE id = ? AND project_id = ?",
        [taskId, projectId],
      );
      if (!taskCheck.length || !taskCheck[0].values.length) {
        return reply.code(404).send({ error: "Task not found" });
      }

      const { kind, content, iteration = null, workflow_id = null } =
        validation.data;
      const contentHash = createHash("sha256").update(content).digest("hex");
      const byteSize = Buffer.byteLength(content, "utf8");

      try {
        const existing = db.exec(
          `SELECT id FROM artifacts
           WHERE project_id = ? AND task_id = ? AND kind = ?
             AND COALESCE(iteration, -1) = COALESCE(?, -1)`,
          [projectId, taskId, kind, iteration],
        );

        let artifactId: number;
        let created = false;

        if (existing.length && existing[0].values.length) {
          artifactId = existing[0].values[0][0] as number;
          db.run(
            `UPDATE artifacts
             SET content = ?, content_hash = ?, byte_size = ?, workflow_id = ?,
                 updated_at = datetime('now')
             WHERE id = ?`,
            [content, contentHash, byteSize, workflow_id, artifactId],
          );
        } else {
          db.run(
            `INSERT INTO artifacts
             (project_id, task_id, workflow_id, kind, iteration, content, content_hash, byte_size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              projectId,
              taskId,
              workflow_id,
              kind,
              iteration,
              content,
              contentHash,
              byteSize,
            ],
          );
          artifactId = db.exec("SELECT last_insert_rowid()")[0]
            .values[0][0] as number;
          created = true;
        }

        await saveDb(db);

        const result = db.exec(
          `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`,
          [artifactId],
        );
        const artifact = rowToArtifact(result[0].values[0], false);

        return reply.code(created ? 201 : 200).send(artifact);
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    },
  );

  fastify.get(
    "/projects/:projectId/tasks/:taskId/artifacts",
    async (request: any, reply: any) => {
      const projectId = parseInt(request.params.projectId, 10);
      const taskId = parseInt(request.params.taskId, 10);
      if (!Number.isInteger(projectId) || !Number.isInteger(taskId)) {
        return reply.code(400).send({ error: "Invalid project or task id" });
      }

      const { kind, latest, meta_only } = request.query || {};
      const db = await getDb();

      const clauses = ["project_id = ?", "task_id = ?"];
      const params: any[] = [projectId, taskId];
      if (kind) {
        clauses.push("kind = ?");
        params.push(String(kind));
      }

      const limitClause = latest === "1" || latest === "true" ? "LIMIT 1" : "";
      const result = db.exec(
        `SELECT ${ARTIFACT_COLUMNS} FROM artifacts
         WHERE ${clauses.join(" AND ")}
         ORDER BY COALESCE(iteration, -1) DESC, updated_at DESC, id DESC
         ${limitClause}`,
        params,
      );

      if (!result.length) {
        return reply.send({ data: [] });
      }

      const includeContent = !(meta_only === "1" || meta_only === "true");
      const artifacts = result[0].values.map((row) =>
        rowToArtifact(row, includeContent),
      );

      return reply.send({ data: artifacts });
    },
  );
}
