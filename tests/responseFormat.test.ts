import { describe, it, expect, vi, beforeEach } from "vitest";
import { callLMStudio } from "../src/lmstudio";
import { cfg } from "../src/config";
import { lmStudioCircuitBreaker } from "../src/services/LMStudioCircuitBreaker";
import {
  getPersonaResponseFormat,
  personasWithSchemas,
} from "../src/personas/responseSchemas";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, fetch: fetchMock };
});

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  };
}

function errorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => null,
  };
}

describe("getPersonaResponseFormat", () => {
  it("provides schemas for verdict and planner personas", () => {
    for (const persona of [
      "plan-evaluator",
      "tester-qa",
      "code-reviewer",
      "security-review",
      "implementation-planner",
    ]) {
      const format = getPersonaResponseFormat(persona);
      expect(format).toBeDefined();
      expect(format!.type).toBe("json_schema");
      expect(format!.json_schema.schema).toBeDefined();
      expect(personasWithSchemas()).toContain(persona);
    }
  });

  it("returns undefined for free-form personas", () => {
    expect(getPersonaResponseFormat("lead-engineer")).toBeUndefined();
    expect(getPersonaResponseFormat("researcher")).toBeUndefined();
    expect(getPersonaResponseFormat("nonexistent")).toBeUndefined();
  });

  it("caps the planner's plan array so responses cannot outgrow max_tokens", () => {
    const schema = getPersonaResponseFormat("implementation-planner")!
      .json_schema.schema as any;
    expect(schema.properties.plan.maxItems).toBeLessThanOrEqual(8);
    expect(
      schema.properties.plan.items.properties.key_files.maxItems,
    ).toBeGreaterThan(0);
  });

  it("requires a status field on every verdict schema", () => {
    for (const persona of [
      "plan-evaluator",
      "tester-qa",
      "code-reviewer",
      "security-review",
    ]) {
      const schema = getPersonaResponseFormat(persona)!.json_schema
        .schema as any;
      expect(schema.required).toContain("status");
      expect(schema.properties.status.enum).toEqual(["pass", "fail"]);
    }
  });
});

describe("callLMStudio response_format handling", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    lmStudioCircuitBreaker.reset();
    (cfg as any).lmsMaxTokens = 6000;
    (cfg as any).lmsFrequencyPenalty = 0.5;
  });

  it("includes response_format in the request payload", async () => {
    fetchMock.mockResolvedValue(okResponse('{"status":"pass"}'));

    const format = getPersonaResponseFormat("plan-evaluator")!;
    const result = await callLMStudio(
      "test-model",
      [{ role: "user", content: "evaluate" }],
      0.2,
      { responseFormat: format, retries: 0 },
    );

    expect(result.content).toBe('{"status":"pass"}');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toEqual(format);
  });

  it("surfaces finish_reason so callers can detect truncation", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { content: '{"plan": [' }, finish_reason: "length" },
        ],
      }),
      text: async () => "",
    });

    const result = await callLMStudio(
      "test-model",
      [{ role: "user", content: "plan" }],
      0.2,
      { retries: 0 },
    );

    expect(result.finishReason).toBe("length");
  });

  it("includes max_tokens from config in the request payload", async () => {
    fetchMock.mockResolvedValue(okResponse("ok"));

    await callLMStudio("test-model", [{ role: "user", content: "hi" }], 0.2, {
      retries: 0,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("includes frequency_penalty from config in the request payload", async () => {
    fetchMock.mockResolvedValue(okResponse("ok"));

    await callLMStudio("test-model", [{ role: "user", content: "hi" }], 0.2, {
      retries: 0,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.frequency_penalty).toBe(0.5);
  });

  it("allows overriding max_tokens per call", async () => {
    fetchMock.mockResolvedValue(okResponse("ok"));

    await callLMStudio("test-model", [{ role: "user", content: "hi" }], 0.2, {
      retries: 0,
      maxTokens: 1234,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(1234);
  });

  it("allows overriding frequency_penalty per call", async () => {
    fetchMock.mockResolvedValue(okResponse("ok"));

    await callLMStudio("test-model", [{ role: "user", content: "hi" }], 0.2, {
      retries: 0,
      frequencyPenalty: 1.0,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.frequency_penalty).toBe(1.0);
  });

  it("omits response_format when not provided", async () => {
    fetchMock.mockResolvedValue(okResponse("plain text"));

    await callLMStudio(
      "test-model",
      [{ role: "user", content: "hi" }],
      0.2,
      { retries: 0 },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toBeUndefined();
  });

  it("retries once without response_format when the server rejects it", async () => {
    fetchMock
      .mockResolvedValueOnce(
        errorResponse(400, "response_format not supported"),
      )
      .mockResolvedValueOnce(okResponse('{"status":"fail"}'));

    const format = getPersonaResponseFormat("tester-qa")!;
    const result = await callLMStudio(
      "test-model",
      [{ role: "user", content: "qa" }],
      0.2,
      { responseFormat: format, retries: 0 },
    );

    expect(result.content).toBe('{"status":"fail"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.response_format).toBeDefined();
    expect(secondBody.response_format).toBeUndefined();
  });

  it("does not treat the schema-rejection retry as a circuit breaker failure", async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(400, "unsupported"))
      .mockResolvedValueOnce(okResponse("ok"));

    await callLMStudio("test-model", [{ role: "user", content: "x" }], 0.2, {
      responseFormat: getPersonaResponseFormat("plan-evaluator")!,
      retries: 0,
    });

    expect(lmStudioCircuitBreaker.getStats().failureCount).toBe(0);
  });

  it("still fails on 400 when no response_format was sent", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, "bad request"));

    await expect(
      callLMStudio("test-model", [{ role: "user", content: "x" }], 0.2, {
        retries: 0,
      }),
    ).rejects.toThrow(/LM Studio error 400|fetch failed/);
  });

  it("does not retry context length errors or trip the circuit breaker", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(
        400,
        "The number of tokens to keep from the initial prompt is greater than the context length.",
      ),
    );

    let caught: any;
    try {
      await callLMStudio(
        "test-model",
        [{ role: "user", content: "x" }],
        0.2,
        {
          responseFormat: getPersonaResponseFormat("plan-evaluator")!,
          retries: 3,
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught?.promptTooLarge).toBe(true);
    expect(caught?.nonRetryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lmStudioCircuitBreaker.getStats().failureCount).toBe(0);
  });
});
