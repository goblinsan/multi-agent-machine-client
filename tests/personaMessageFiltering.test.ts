import { describe, it, expect, beforeEach, vi } from "vitest";
import { PersonaConsumer } from "../src/personas/PersonaConsumer.js";
import { LocalTransport } from "../src/transport/LocalTransport.js";
import { cfg } from "../src/config.js";

describe("PersonaConsumer message filtering", () => {
  let transport: LocalTransport;
  let consumer: PersonaConsumer;

  beforeEach(async () => {
    transport = new LocalTransport();
    consumer = new PersonaConsumer(transport);
  });

  it("should only process messages addressed to the correct persona", async () => {
    const processedRequests: Array<{
      persona: string;
      toPersona: string;
      messageId: string;
    }> = [];

    vi.spyOn(consumer as any, "executePersonaRequest").mockImplementation(
      async (opts: any) => {
        processedRequests.push({
          persona: opts.persona,
          toPersona: opts.payload.to_persona || "unknown",
          messageId: opts.workflowId,
        });
        return {
          status: "pass",
          result: "test result",
        };
      },
    );

    const _startPromise = consumer.start({
      personas: ["context", "plan-evaluator", "implementation-planner"],
      blockMs: 100,
      batchSize: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-1",
      to_persona: "context",
      step: "1-context",
      intent: "context_gathering",
      corr_id: "corr-1",
      payload: JSON.stringify({ task: "test" }),
    });

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-2",
      to_persona: "plan-evaluator",
      step: "2-evaluate",
      intent: "plan_evaluation",
      corr_id: "corr-2",
      payload: JSON.stringify({ plan: "test plan" }),
    });

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-3",
      to_persona: "implementation-planner",
      step: "2-plan",
      intent: "planning",
      corr_id: "corr-3",
      payload: JSON.stringify({ task: "test" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1));

    await consumer.stop();

    expect(processedRequests.length).toBe(3);

    const contextRequests = processedRequests.filter(
      (r) => r.persona === "context",
    );
    expect(contextRequests.length).toBe(1);
    expect(contextRequests[0].messageId).toBe("wf-1");

    const planEvalRequests = processedRequests.filter(
      (r) => r.persona === "plan-evaluator",
    );
    expect(planEvalRequests.length).toBe(1);
    expect(planEvalRequests[0].messageId).toBe("wf-2");

    const plannerRequests = processedRequests.filter(
      (r) => r.persona === "implementation-planner",
    );
    expect(plannerRequests.length).toBe(1);
    expect(plannerRequests[0].messageId).toBe("wf-3");
  });

  it("should acknowledge but not process messages for other personas", async () => {
    const ackedMessages: string[] = [];

    const originalXAck = transport.xAck.bind(transport);
    vi.spyOn(transport, "xAck").mockImplementation(
      async (stream, group, messageId) => {
        ackedMessages.push(messageId);
        return originalXAck(stream, group, messageId);
      },
    );

    const executedPersonas: string[] = [];
    vi.spyOn(consumer as any, "executePersonaRequest").mockImplementation(
      async (opts: any) => {
        executedPersonas.push(opts.persona);
        return { status: "pass", result: "test" };
      },
    );

    await consumer.start({
      personas: ["context"],
      blockMs: 100,
      batchSize: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const contextMsgId = await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-context",
      to_persona: "context",
      step: "1-context",
      intent: "context_gathering",
      corr_id: "corr-ctx",
      payload: JSON.stringify({}),
    });

    const plannerMsgId = await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-planner",
      to_persona: "implementation-planner",
      step: "2-plan",
      intent: "planning",
      corr_id: "corr-plan",
      payload: JSON.stringify({}),
    });

    await new Promise((resolve) => setTimeout(resolve, 1));
    await consumer.stop();

    expect(ackedMessages).toContain(contextMsgId);
    expect(executedPersonas).toContain("context");

    expect(ackedMessages).toContain(plannerMsgId);
    expect(executedPersonas).not.toContain("implementation-planner");
    expect(executedPersonas.length).toBe(1);
  });

  it("should prevent race condition where all personas process coordinator messages", async () => {
    const processLog: Array<{
      persona: string;
      workflowId: string;
      toPersona: string;
    }> = [];

    vi.spyOn(consumer as any, "executePersonaRequest").mockImplementation(
      async (opts: any) => {
        processLog.push({
          persona: opts.persona,
          workflowId: opts.workflowId,
          toPersona: opts.payload.to_persona || "unknown",
        });
        return { status: "pass", result: "test" };
      },
    );

    await consumer.start({
      personas: [
        "context",
        "plan-evaluator",
        "implementation-planner",
        "lead-engineer",
        "code-reviewer",
        "security-review",
        "tester-qa",
        "coordination",
        "project-manager",
        "architect",
        "summarization",
      ],
      blockMs: 100,
      batchSize: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf_coord_test",
      to_persona: "context",
      step: "1-context",
      intent: "context_gathering",
      corr_id: "coord-corr-1",
      from: "coordination",
      payload: JSON.stringify({ task: "milestone setup" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1));
    await consumer.stop();

    const contextProcessed = processLog.filter((p) => p.persona === "context");
    expect(contextProcessed.length).toBe(1);
    expect(contextProcessed[0].workflowId).toBe("wf_coord_test");

    const otherPersonas = processLog.filter((p) => p.persona !== "context");
    expect(otherPersonas.length).toBe(0);

    expect(processLog.length).toBe(1);
  });

  it("should handle messages with missing to_persona field gracefully", async () => {
    const executedWorkflows: string[] = [];

    vi.spyOn(consumer as any, "executePersonaRequest").mockImplementation(
      async (opts: any) => {
        executedWorkflows.push(opts.workflowId);
        return { status: "pass", result: "test" };
      },
    );

    await consumer.start({
      personas: ["context"],
      blockMs: 100,
      batchSize: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-no-target",
      step: "1-context",
      intent: "context_gathering",
      corr_id: "corr-no-target",
      payload: JSON.stringify({}),
    });

    await new Promise((resolve) => setTimeout(resolve, 1));
    await consumer.stop();

    expect(executedWorkflows).toContain("wf-no-target");
  });
});
