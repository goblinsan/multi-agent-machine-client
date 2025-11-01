import { vi } from "vitest";
import { ProjectAPI } from "../../src/dashboard/ProjectAPI.js";
import { TaskAPI } from "../../src/dashboard/TaskAPI.js";
import * as persona from "../../src/agents/persona.js";
import * as tasks from "../../src/tasks/taskManager.js";
import * as fileops from "../../src/fileops.js";
import * as gitUtils from "../../src/gitUtils.js";
import { sent } from "../testCapture.js";

export function createRedisMock() {
  return {
    makeRedis: vi.fn().mockResolvedValue({
      xGroupCreate: vi.fn().mockResolvedValue(null),
      xReadGroup: vi.fn().mockResolvedValue([]),
      xAck: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn().mockResolvedValue(null),
      quit: vi.fn().mockResolvedValue(null),
      xRevRange: vi.fn().mockResolvedValue([]),
      xAdd: vi.fn().mockResolvedValue("test-id"),
      exists: vi.fn().mockResolvedValue(1),
    }),
  };
}

export interface TestProject {
  id: string;
  name: string;
  tasks: Array<{
    id: string;
    name: string;
    status: string;
    lock_version?: number;
  }>;
  next_milestone?: { id: string; name: string };
  repositories?: Array<{ url: string }>;
}

export interface TestMilestone {
  id: string;
  name: string;
  slug: string;
  tasks: Array<{ id: string; name: string; status: string }>;
}

export class DashboardMockHelper {
  private project: TestProject;
  private milestones: TestMilestone[];
  private updatedTasks: Record<string, string> = {};
  public updateTaskStatusSpy: any;
  private projectAPIMock: any;
  private taskAPIMock: any;

  constructor(project: TestProject, milestones: TestMilestone[] = []) {
    this.project = project;
    this.milestones = milestones;
  }

  setupMocks() {
    vi.spyOn(ProjectAPI.prototype, "fetchProjectStatus").mockImplementation(
      async () => {
        const openTasks = this.project.tasks.filter(
          (t) => this.updatedTasks[t.id] !== "done",
        );
        return { ...this.project, tasks: openTasks } as any;
      },
    );

    vi.spyOn(
      ProjectAPI.prototype,
      "fetchProjectStatusDetails",
    ).mockImplementation(async () => {
      return this.milestones.length > 0
        ? ({ milestones: this.milestones } as any)
        : (null as any);
    });

    vi.spyOn(ProjectAPI.prototype, "fetchProjectMilestones").mockResolvedValue(
      this.milestones as any,
    );

    vi.spyOn(ProjectAPI.prototype, "fetchProjectTasks").mockImplementation(
      async () => {
        const openTasks = this.project.tasks.filter(
          (t) => this.updatedTasks[t.id] !== "done",
        );
        return openTasks as any;
      },
    );

    vi.spyOn(TaskAPI.prototype, "fetchTask").mockImplementation(
      async (taskId: string) => {
        const task = this.project.tasks.find((t) => t.id === taskId);
        return { ...task, lock_version: task?.lock_version || 0 } as any;
      },
    );

    this.updateTaskStatusSpy = vi
      .spyOn(TaskAPI.prototype, "updateTaskStatus")
      .mockImplementation(async (taskId: string, status: string) => {
        this.updatedTasks[taskId] = status;

        const task = this.project.tasks.find((t) => t.id === taskId);
        if (task) {
          task.status = status;
        }

        this.milestones.forEach((m) => {
          const task = m.tasks.find((t) => t.id === taskId);
          if (task) {
            task.status = status;
          }
        });

        return { ok: true, status: 200, body: {} } as any;
      });

    return this;
  }

  getUpdatedTasks() {
    return { ...this.updatedTasks };
  }

  resetTaskUpdates() {
    this.updatedTasks = {};
    return this;
  }
}

export interface PersonaCompletions {
  [stepKey: string]: any;
}

export class PersonaMockHelper {
  private completions: PersonaCompletions = {};

  constructor(completions: PersonaCompletions = {}) {
    this.completions = {
      "1-context": {
        fields: { result: JSON.stringify({}) },
        id: "evt-context",
      },
      "2-plan": {
        fields: {
          result: JSON.stringify({
            payload: { plan: [{ goal: "implement feature" }] },
          }),
        },
        id: "evt-plan",
      },
      "2-implementation": {
        fields: {
          result: JSON.stringify({
            status: "ok",
            output: "built",
            ops: [{ action: "upsert", path: "dummy.txt", content: "hello" }],
          }),
        },
        id: "evt-impl",
      },
      "3-qa": {
        fields: {
          result: JSON.stringify({ status: "pass", details: "tests passed" }),
        },
        id: "evt-qa",
      },
      "3-code-review": {
        fields: {
          result: JSON.stringify({ status: "pass", details: "review ok" }),
        },
        id: "evt-cr",
      },
      "3-security": {
        fields: {
          result: JSON.stringify({ status: "pass", details: "security ok" }),
        },
        id: "evt-sec",
      },
      "3-devops": {
        fields: {
          result: JSON.stringify({ status: "pass", details: "deployed" }),
        },
        id: "evt-devops",
      },
      "4-implementation-plan": {
        fields: {
          result: JSON.stringify({ payload: { plan: [{ goal: "followup" }] } }),
        },
        id: "evt-final-plan",
      },

      "plan-evaluator-pass": {
        fields: { result: JSON.stringify({ status: "pass" }) },
        id: "evt-eval-pass",
      },
      "plan-evaluator-fail": {
        fields: {
          result: JSON.stringify({
            status: "fail",
            reason: "Plan not relevant to feedback",
          }),
        },
        id: "evt-eval-fail",
      },

      "3.6-plan-revision": {
        fields: {
          result: JSON.stringify({
            payload: { plan: [{ goal: "address QA feedback" }] },
            output: "",
          }),
        },
        id: "evt-plan-revised",
      },
      "3.7-evaluate-qa-plan-revised": {
        fields: { result: JSON.stringify({ status: "pass" }) },
        id: "evt-eval-pass-revised",
      },
      "qa-created-tasks": {
        fields: {
          result: JSON.stringify({ payload: { plan: [{ goal: "followup" }] } }),
        },
        id: "evt-planner-followup",
      },
      ...completions,
    };
  }

  setupMocks() {
    sent.length = 0;

    vi.spyOn(persona, "sendPersonaRequest").mockImplementation(
      async (_r: any, opts: any) => {
        const corrId = opts.corrId || `corr-${sent.length + 1}`;
        const fullOpts = { ...opts, corrId };
        sent.push(fullOpts);
        return corrId;
      },
    );

    vi.spyOn(persona, "waitForPersonaCompletion").mockImplementation(
      async (
        _r: any,
        toPersona: string,
        workflowId: string,
        corrId: string,
        _timeoutMs?: number,
      ) => {
        const match = sent.find((s) => s.corrId === corrId) as any;

        if (!match) {
          if (this.completions[corrId]) {
            return this.completions[corrId];
          }
          return {
            fields: { result: JSON.stringify({ status: "ok" }) },
            id: "evt-default",
          } as any;
        }

        const step = match.step;

        if (match.toPersona === "plan-evaluator") {
          const plan = match.payload?.plan;
          if (plan && this.shouldEvaluatorFail(plan)) {
            return this.completions["plan-evaluator-fail"];
          } else {
            return this.completions["plan-evaluator-pass"];
          }
        }

        if (match.toPersona === "project-manager") {
          return {
            fields: { result: JSON.stringify({ status: "pass" }) },
            id: "evt-pm",
          };
        }

        if (this.completions[step]) {
          const completion = this.completions[step];

          return completion;
        }

        return {
          fields: { result: JSON.stringify({ status: "ok" }) },
          id: "evt-unknown",
        } as any;
      },
    );

    return this;
  }

  addCompletion(stepKey: string, completion: any) {
    this.completions[stepKey] = completion;
    return this;
  }

  private shouldEvaluatorFail(plan: any): boolean {
    if (plan?.payload?.plan?.[0]?.goal === "implement new feature") {
      return true;
    }
    if (plan?.plan?.[0]?.goal === "implement new feature") {
      return true;
    }
    return false;
  }
}

export class GitMockHelper {
  private verifyCounter = 0;
  private localShaCounter = 0;
  private remoteShaCounter = 0;

  setupMocks() {
    vi.spyOn(fileops, "applyEditOps").mockResolvedValue({
      changed: ["dummy.txt"],
      branch: "feat/agent-edit",
      sha: "12345",
    });

    vi.spyOn(gitUtils, "commitAndPushPaths").mockResolvedValue({
      committed: true,
      pushed: true,
      branch: "feat/agent-edit",
    });

    vi.spyOn(gitUtils, "verifyRemoteBranchHasDiff").mockImplementation(
      async () => {
        this.verifyCounter += 1;
        return {
          ok: true,
          hasDiff: true,
          branch: "feat/agent-edit",
          baseBranch: "main",
          branchSha: `verify-sha-${this.verifyCounter}`,
          baseSha: "base",
          aheadCount: 1,
          diffSummary: "1 file changed",
        } as any;
      },
    );

    vi.spyOn(gitUtils, "getBranchHeadSha").mockImplementation(
      async ({ remote }) => {
        if (remote) {
          this.remoteShaCounter += 1;
          if (this.remoteShaCounter === 1) return null;
          return `remote-sha-${this.remoteShaCounter}`;
        }
        this.localShaCounter += 1;
        return `local-sha-${this.localShaCounter}`;
      },
    );

    vi.spyOn(gitUtils, "resolveRepoFromPayload").mockResolvedValue({
      repoRoot: "/tmp/repo",
      branch: "main",
      remote: "https://example/repo.git",
    } as any);

    vi.spyOn(gitUtils, "getRepoMetadata").mockResolvedValue({
      remoteSlug: "example/repo",
      currentBranch: "main",
    } as any);

    vi.spyOn(gitUtils, "checkoutBranchFromBase").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(gitUtils, "ensureBranchPublished").mockResolvedValue(
      undefined as any,
    );

    return this;
  }

  resetCounters() {
    this.verifyCounter = 0;
    this.localShaCounter = 0;
    this.remoteShaCounter = 0;
    return this;
  }
}

export class TaskMockHelper {
  setupMocks() {
    vi.spyOn(
      tasks,
      "createDashboardTaskEntriesWithSummarizer",
    ).mockResolvedValue([
      {
        title: "auto-task",
        externalId: "ext-x",
        createdId: "created-x",
        description: "auto-created task",
      } as any,
    ]);

    return this;
  }

  setupQAFailureMocks() {
    vi.spyOn(
      tasks,
      "createDashboardTaskEntriesWithSummarizer",
    ).mockResolvedValue([
      {
        title: "QA failure task",
        externalId: "ext-1",
        createdId: "t-1",
        description: "Condensed description about missing tests",
      } as any,
    ]);

    return this;
  }
}

export async function setupCoordinatorMocks() {
  vi.mock("../../src/redisClient.js", async () => {
    const actual = (await vi.importActual("../../src/redisClient.js")) as any;
    return {
      ...actual,
      makeRedis: vi.fn().mockResolvedValue({
        xGroupCreate: vi.fn().mockResolvedValue(null),
        xReadGroup: vi.fn().mockResolvedValue([]),
        xAck: vi.fn().mockResolvedValue(null),
        disconnect: vi.fn().mockResolvedValue(null),
        quit: vi.fn().mockResolvedValue(null),
        xRevRange: vi.fn().mockResolvedValue([]),
        xAdd: vi.fn().mockResolvedValue("test-id"),
        exists: vi.fn().mockResolvedValue(1),
      }),
    };
  });
}

export function setupAllMocks(
  project: TestProject,
  milestones: TestMilestone[] = [],
  personaCompletions: PersonaCompletions = {},
) {
  const dashboardHelper = new DashboardMockHelper(
    project,
    milestones,
  ).setupMocks();
  const personaHelper = new PersonaMockHelper(personaCompletions).setupMocks();
  const gitHelper = new GitMockHelper().setupMocks();
  const taskHelper = new TaskMockHelper().setupMocks();

  setupCoordinatorMocks();

  return {
    dashboard: dashboardHelper,
    persona: personaHelper,
    git: gitHelper,
    task: taskHelper,
    getSentRequests: () => sent,
    clearSentRequests: () => {
      sent.length = 0;
    },
  };
}

export * as coordinatorMod from "../../src/workflows/WorkflowCoordinator.js";
