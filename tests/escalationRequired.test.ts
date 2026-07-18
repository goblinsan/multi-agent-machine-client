import { describe, it, expect, vi } from "vitest";
import {
  EscalationRequiredError,
  escalationRequired,
  handleEscalationRequired,
  isEscalationRequired,
  toEscalationArtifact,
  ESCALATION_REASON,
} from "../src/workflows/escalation/escalationRequired";

const details = {
  changeSlug: "openapi",
  failingFiles: [{ path: "src/routes/openapi.ts", contract: "exports registerOpenApiRoutes" }],
  convergenceErrors: ["Module '\"./doc\"' has no exported member 'openApiDocument'."],
  attempts: 2,
};

describe("escalationRequired", () => {
  it("throws a typed error carrying the change context", () => {
    try {
      escalationRequired(details);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isEscalationRequired(err)).toBe(true);
      const e = err as EscalationRequiredError;
      expect(e.changeSlug).toBe("openapi");
      expect(e.attempts).toBe(2);
      expect(e.failingFiles[0].path).toBe("src/routes/openapi.ts");
    }
  });

  it("serializes to a parseable escalation artifact", () => {
    const err = new EscalationRequiredError(details);
    const artifact = toEscalationArtifact(err);
    expect(artifact.kind).toBe("escalation_required");
    const parsed = JSON.parse(artifact.content);
    expect(parsed.reason).toBe(ESCALATION_REASON);
    expect(parsed.convergenceErrors).toHaveLength(1);
  });

  it("blocks the change and publishes the artifact when there is no reviewer", async () => {
    const err = new EscalationRequiredError(details);
    const blockChange = vi.fn().mockResolvedValue(undefined);
    const publishArtifact = vi.fn().mockResolvedValue(undefined);

    const result = await handleEscalationRequired(err, { blockChange, publishArtifact });

    expect(result.replanned).toBe(false);
    expect(publishArtifact).toHaveBeenCalledOnce();
    expect(blockChange).toHaveBeenCalledWith("openapi", ESCALATION_REASON);
  });

  it("is the seam: a reviewer that replans short-circuits the block", async () => {
    const err = new EscalationRequiredError(details);
    const blockChange = vi.fn().mockResolvedValue(undefined);
    const publishArtifact = vi.fn().mockResolvedValue(undefined);
    const reviewAndReplan = vi.fn().mockResolvedValue(true);

    const result = await handleEscalationRequired(err, {
      blockChange,
      publishArtifact,
      reviewAndReplan,
    });

    expect(result.replanned).toBe(true);
    expect(reviewAndReplan).toHaveBeenCalledOnce();
    expect(blockChange).not.toHaveBeenCalled();
  });

  it("still blocks when the reviewer declines to replan", async () => {
    const err = new EscalationRequiredError(details);
    const blockChange = vi.fn().mockResolvedValue(undefined);
    const publishArtifact = vi.fn().mockResolvedValue(undefined);
    const reviewAndReplan = vi.fn().mockResolvedValue(false);

    const result = await handleEscalationRequired(err, {
      blockChange,
      publishArtifact,
      reviewAndReplan,
    });

    expect(result.replanned).toBe(false);
    expect(blockChange).toHaveBeenCalledWith("openapi", ESCALATION_REASON);
  });
});
