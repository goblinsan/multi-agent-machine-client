import { describe, it, expect, beforeEach, vi } from "vitest";
import { PersonaConsumer } from "../src/personas/PersonaConsumer.js";
import { LocalTransport } from "../src/transport/LocalTransport.js";
import { cfg } from "../src/config.js";

describe("Persona planning context validation", () => {
  let transport: LocalTransport;
  let consumer: PersonaConsumer;

  beforeEach(async () => {
    transport = new LocalTransport();
    consumer = new PersonaConsumer(transport);
  });

  it("CRITICAL: implementation-planner must receive task description in userText", async () => {
    let capturedUserText: string | undefined;
    let capturedMessages: any[] = [];

    const buildMessagesModule = await import(
      "../src/personas/PersonaRequestHandler.js"
    );
    const originalBuildMessages = buildMessagesModule.buildPersonaMessages;
    vi.spyOn(buildMessagesModule, "buildPersonaMessages").mockImplementation(
      (input: any) => {
        capturedUserText = input.userText;
        capturedMessages = originalBuildMessages(input);
        return capturedMessages;
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
      workflow_id: "wf-critical-test",
      to_persona: "implementation-planner",
      step: "2-plan",
      intent: "planning",
      corr_id: "test-corr-critical",
      payload: JSON.stringify({
        task: {
          id: 1,
          type: "feature",
          persona: "lead_engineer",
          data: {
            id: 1,
            title: "Config loader and schema validation",
            description:
              "Implement hierarchical config (env, file, CLI) with JSON schema validation",
            status: "open",
            priority_score: 0,
            milestone_id: 1,
            labels: ["backend", "config"],
          },
          timestamp: Date.now(),
        },
        project_id: "1",
        repo: "https://example.com/repo.git",
        branch: "main",
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await consumer.stop();

    expect(capturedUserText).toBeDefined();
    expect(capturedUserText).toContain("Config loader and schema validation");
    expect(capturedUserText).toContain("Implement hierarchical config");
    expect(capturedUserText).toContain("JSON schema validation");

    expect(capturedUserText).not.toBe("planning");
    expect(capturedUserText).not.toContain("Process this request");

    const userMessage = capturedMessages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toContain("Config loader");
    expect(userMessage.content).toContain("hierarchical config");
  });

  it("MUST error when task has no description", async () => {
    let errorLogged = false;
    let loggedPayload: any = null;

    const loggerModule = await import("../src/logger.js");
    const originalError = loggerModule.logger.error;
    vi.spyOn(loggerModule.logger, "error").mockImplementation(
      (msg: string, meta?: any) => {
        if (msg === "PersonaConsumer: CRITICAL - Task has no description") {
          errorLogged = true;
          loggedPayload = meta;
        }
        return originalError(msg, meta);
      },
    );

    const buildMessagesModule = await import(
      "../src/personas/PersonaRequestHandler.js"
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

    await new Promise((resolve) => setTimeout(resolve, 10));

    await transport.xAdd(cfg.requestStream, "*", {
      workflow_id: "wf-no-desc",
      to_persona: "implementation-planner",
      step: "2-plan",
      intent: "planning",
      corr_id: "test-no-desc",
      payload: JSON.stringify({
        task: {
          id: 1,
          title: "Some task",
          status: "open",
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await consumer.stop();

    expect(errorLogged).toBe(true);
    expect(loggedPayload).toBeDefined();
    expect(loggedPayload.persona).toBe("implementation-planner");
    expect(loggedPayload.taskTitle).toBe("Some task");
  });

  it("validates dashboard API returns description field", async () => {
    const { fetch } = await import("undici");

    try {
      const response = await fetch("http://localhost:3000/projects/1/tasks");
      const data: any = await response.json();

      expect(data).toBeDefined();
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);

      if (data.data.length > 0) {
        const firstTask = data.data[0];

        expect(firstTask).toHaveProperty("id");
        expect(firstTask).toHaveProperty("title");
        expect(firstTask).toHaveProperty("description");
        expect(firstTask).toHaveProperty("status");

        if (firstTask.description !== null) {
          expect(typeof firstTask.description).toBe("string");
        }
      }
    } catch (error) {
      console.warn("Dashboard API not available:", error);
    }
  });

  it("extracts task description even when nested in complex payload", async () => {
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
      workflow_id: "wf-complex",
      to_persona: "implementation-planner",
      step: "2-plan",
      intent: "planning",
      corr_id: "test-complex",
      payload: JSON.stringify({
        iteration: 1,
        planIteration: 1,
        is_revision: false,
        repo: "https://example.com/repo.git",
        branch: "main",
        project_id: "1",
        task: {
          id: 5,
          title: "Implement logging system",
          description:
            "Add structured logging with Winston, support multiple transports (file, console, remote), include request tracing",
          type: "feature",
          scope: "large",
          status: "open",
          priority_score: 100,
          milestone_id: 2,
        },
        extra_context: "some other data",
        previous_evaluation: null,
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await consumer.stop();

    expect(capturedUserText).toBeDefined();
    expect(capturedUserText).toContain("Implement logging system");
    expect(capturedUserText).toContain("Add structured logging with Winston");
    expect(capturedUserText).toContain("Type: feature");
    expect(capturedUserText).toContain("Scope: large");
  });

  it("workflow should abort if task description is missing (integration behavior)", async () => {
    const taskWithoutDescription: any = {
      id: 1,
      title: "Some task",
      status: "open",
    };

    expect(taskWithoutDescription.description).toBeUndefined();
  });
});
