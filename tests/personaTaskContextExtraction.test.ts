import { describe, it, expect, beforeEach, vi } from "vitest";
import { PersonaConsumer } from "../src/personas/PersonaConsumer.js";
import { LocalTransport } from "../src/transport/LocalTransport.js";
import { cfg } from "../src/config.js";

describe("PersonaConsumer task context extraction", () => {
  let transport: LocalTransport;
  let consumer: PersonaConsumer;

  beforeEach(async () => {
    transport = new LocalTransport();
    consumer = new PersonaConsumer(transport);
  });

  it("should extract task description as userText when payload contains task object", async () => {
    let capturedUserText: string | undefined;

    const buildMessagesModule = await import(
      "../src/personas/PersonaRequestHandler.js"
    );
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, "buildPersonaMessages").mockImplementation(
      (input: any) => {
        capturedUserText = input.userText;
        return originalBuildMessages(input);
      },
    );

    vi.spyOn(buildMessagesModule, "callPersonaModel").mockResolvedValue({
      content: '{"plan": [{"goal": "test"}]}',
      duration_ms: 100,
    });

    await consumer.start({
      personas: ["implementation-planner"],
      blockMs: 100,
      batchSize: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-test",
      to_persona: "implementation-planner",
      step: "2-plan",
      intent: "planning",
      corr_id: "test-corr",
      payload: JSON.stringify({
        task: {
          id: 1,
          title: "Config loader and schema validation",
          description:
            "Implement hierarchical config (env, file, CLI) with JSON schema validation",
          type: "feature",
          scope: "medium",
        },
        context: { repo: "test-repo" },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1));
    await consumer.stop();

    expect(capturedUserText).toBeDefined();
    expect(capturedUserText).toContain("Config loader and schema validation");
    expect(capturedUserText).toContain("Implement hierarchical config");
    expect(capturedUserText).toContain("Type: feature");
    expect(capturedUserText).toContain("Scope: medium");

    expect(capturedUserText).not.toBe("planning");
  });

  it("should use payload.user_text if provided (highest priority)", async () => {
    let capturedUserText: string | undefined;

    const buildMessagesModule = await import(
      "../src/personas/PersonaRequestHandler.js"
    );
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, "buildPersonaMessages").mockImplementation(
      (input: any) => {
        capturedUserText = input.userText;
        return originalBuildMessages(input);
      },
    );

    vi.spyOn(buildMessagesModule, "callPersonaModel").mockResolvedValue({
      content: "test response",
      duration_ms: 100,
    });

    await consumer.start({
      personas: ["context"],
      blockMs: 100,
      batchSize: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-test-2",
      to_persona: "context",
      step: "1-context",
      intent: "context_gathering",
      corr_id: "test-corr-2",
      payload: JSON.stringify({
        user_text: "Custom explicit instruction for this persona",
        task: {
          title: "Some task",
          description: "This should be ignored",
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1));
    await consumer.stop();

    expect(capturedUserText).toBe(
      "Custom explicit instruction for this persona",
    );
    expect(capturedUserText).not.toContain("This should be ignored");
  });

  it("should fall back to payload.description if no task object", async () => {
    let capturedUserText: string | undefined;

    const buildMessagesModule = await import(
      "../src/personas/PersonaRequestHandler.js"
    );
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, "buildPersonaMessages").mockImplementation(
      (input: any) => {
        capturedUserText = input.userText;
        return originalBuildMessages(input);
      },
    );

    vi.spyOn(buildMessagesModule, "callPersonaModel").mockResolvedValue({
      content: "test response",
      duration_ms: 100,
    });

    await consumer.start({
      personas: ["context"],
      blockMs: 100,
      batchSize: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-test-3",
      to_persona: "context",
      step: "1-context",
      intent: "context_gathering",
      corr_id: "test-corr-3",
      payload: JSON.stringify({
        description: "Analyze the repository structure",
        some_other_field: "value",
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1));
    await consumer.stop();

    expect(capturedUserText).toBe("Analyze the repository structure");
  });

  it("should log error if task.description is missing", async () => {
    let errorLogged = false;
    let errorDetails: any = null;

    const loggerModule = await import("../src/logger.js");
    const originalError = loggerModule.logger.error;
    vi.spyOn(loggerModule.logger, "error").mockImplementation(
      (msg: string, meta?: any) => {
        if (msg === "PersonaConsumer: CRITICAL - Task has no description") {
          errorLogged = true;
          errorDetails = meta;
        }
        return originalError(msg, meta);
      },
    );

    const buildMessagesModule = await import(
      "../src/personas/PersonaRequestHandler.js"
    );

    vi.spyOn(buildMessagesModule, "callPersonaModel").mockResolvedValue({
      content: "test response",
      duration_ms: 100,
    });

    await consumer.start({
      personas: ["implementation-planner"],
      blockMs: 100,
      batchSize: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-test-4",
      to_persona: "implementation-planner",
      step: "2-plan",
      intent: "planning",
      corr_id: "test-corr-4",
      payload: JSON.stringify({
        task: {
          id: 5,
          title: "Implement logging system",
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await consumer.stop();

    expect(errorLogged).toBe(true);
    expect(errorDetails).toBeDefined();
    expect(errorDetails.taskTitle).toBe("Implement logging system");
    expect(errorDetails.reason).toContain("Task description is required");
  });

  it("should fall back to intent if no other context available", async () => {
    let capturedUserText: string | undefined;

    const buildMessagesModule = await import(
      "../src/personas/PersonaRequestHandler.js"
    );
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, "buildPersonaMessages").mockImplementation(
      (input: any) => {
        capturedUserText = input.userText;
        return originalBuildMessages(input);
      },
    );

    vi.spyOn(buildMessagesModule, "callPersonaModel").mockResolvedValue({
      content: "test response",
      duration_ms: 100,
    });

    await consumer.start({
      personas: ["context"],
      blockMs: 100,
      batchSize: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-test-5",
      to_persona: "context",
      step: "1-context",
      intent: "context_gathering",
      corr_id: "test-corr-5",
      payload: JSON.stringify({}),
    });

    await new Promise((resolve) => setTimeout(resolve, 1));
    await consumer.stop();

    expect(capturedUserText).toBeUndefined();
  });

  it("should prevent bug where personas get generic prompts instead of task requirements", async () => {
    let capturedUserText: string | undefined;

    const buildMessagesModule = await import(
      "../src/personas/PersonaRequestHandler.js"
    );
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, "buildPersonaMessages").mockImplementation(
      (input: any) => {
        capturedUserText = input.userText;
        return originalBuildMessages(input);
      },
    );

    vi.spyOn(buildMessagesModule, "callPersonaModel").mockResolvedValue({
      content: "test",
      duration_ms: 1,
    });

    await consumer.start({
      personas: ["implementation-planner"],
      blockMs: 100,
      batchSize: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-real-scenario",
      to_persona: "implementation-planner",
      step: "2-plan",
      intent: "planning",
      corr_id: "real-corr",
      payload: JSON.stringify({
        task: {
          id: 1,
          title: "Log file summarization",
          description:
            "Build a system to parse and summarize application log files",
          type: "feature",
          scope: "large",
        },
        iteration: 1,
        repo: "https://github.com/example/log-summarizer.git",
        branch: "main",
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1));
    await consumer.stop();

    expect(capturedUserText).not.toBe("planning");
    expect(capturedUserText).toContain("Log file summarization");
    expect(capturedUserText).toContain(
      "parse and summarize application log files",
    );
  });
});
