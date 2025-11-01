import type { EditSpec, UpsertOp } from "../../../fileops.js";

export function validateEditSpec(spec: EditSpec): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!spec || !spec.ops || !Array.isArray(spec.ops)) {
    errors.push("Edit spec must have ops array");
    return { valid: false, errors, warnings };
  }

  if (spec.ops.length === 0) {
    warnings.push("Edit spec has no operations");
  }

  for (let i = 0; i < spec.ops.length; i++) {
    const op = spec.ops[i];

    if (!op || typeof op !== "object") {
      errors.push(`Operation ${i} is not an object`);
      continue;
    }

    if (!op.action || typeof op.action !== "string") {
      errors.push(`Operation ${i} missing or invalid action`);
      continue;
    }

    if (!op.path || typeof op.path !== "string") {
      errors.push(`Operation ${i} missing or invalid path`);
      continue;
    }

    if (op.action === "upsert") {
      const upsertOp = op as UpsertOp;
      if (!upsertOp.content && !upsertOp.hunks) {
        errors.push(`Upsert operation ${i} missing content or hunks`);
      }
    } else if (op.action !== "delete") {
      errors.push(`Operation ${i} has unknown action: ${(op as any).action}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
