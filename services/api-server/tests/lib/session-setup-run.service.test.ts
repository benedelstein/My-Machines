import { describe, expect, it } from "vitest";
import type {
  ClientState,
  SessionSetupRun,
  SessionSetupTask,
} from "@repo/shared";
import type { ServerState } from
  "../../src/modules/session-agent/types/server-state.types";
import { SessionSetupRunService } from "../../src/modules/session-agent/services/session-setup-run.service";

function createServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    initialized: true,
    sessionId: "session-1",
    userId: "user-1",
    spriteName: "sprite-1",
    repoCloned: true,
    agentSessionId: null,
    agentProcessId: null,
    agentProcessRunId: null,
    activeUserMessageId: null,
    startupToolchain: null,
    startupScriptCompleted: true,
    finalNetworkPolicyApplied: true,
    sessionConnectorId: null,
    spriteLabelsApplied: false,
    gitAuthMode: "legacy_secret",
    ...overrides,
  };
}

function createClientState(): ClientState {
  return {
    status: "preparing",
    sessionSetupRun: null,
  } as ClientState;
}

function createHarness(args: {
  serverState?: Partial<ServerState>;
  prepareTask?: (task: SessionSetupTask) => SessionSetupTask;
} = {}) {
  const serverState = createServerState(args.serverState);
  const clientState = createClientState();
  const service = new SessionSetupRunService({
    getServerState: () => serverState,
    getClientState: () => clientState,
    updateRunState: (setupRun) => {
      clientState.sessionSetupRun = setupRun;
      switch (setupRun.status) {
        case "running":
          clientState.status = "preparing";
          break;
        case "failed":
          clientState.status = "setup_failed";
          break;
        case "completed":
          clientState.status = "ready";
          break;
      }
    },
  });

  const run = service.buildRun();
  clientState.sessionSetupRun = {
    ...run,
    tasks: run.tasks.map((task) =>
      args.prepareTask ? args.prepareTask(task) : task,
    ),
  };

  return { clientState, service };
}

function completeTask(task: SessionSetupTask): SessionSetupTask {
  return {
    ...task,
    status: "completed",
    startedAt: "2026-06-02T00:00:00.000Z",
    completedAt: "2026-06-02T00:00:00.000Z",
  };
}

function failTask(task: SessionSetupTask): SessionSetupTask {
  return {
    ...task,
    status: "failed",
    startedAt: "2026-06-02T00:00:00.000Z",
    completedAt: "2026-06-02T00:00:00.000Z",
    error: "fatal failure",
  };
}

function requireSetupRun(clientState: ClientState): SessionSetupRun {
  const setupRun = clientState.sessionSetupRun;
  if (!setupRun) { throw new Error("Expected setup run"); }
  return setupRun;
}

describe("SessionSetupRunService", () => {
  it("builds typed setup tasks with task-owned setup metadata", () => {
    const { clientState } = createHarness();

    const setupRun = requireSetupRun(clientState);
    expect(setupRun.tasks.map((task) => [task.id, task.isBlocking, task.canRetry])).toEqual([
      ["cloud_container", true, true],
      ["session_connector", true, true],
      ["repository", true, true],
      ["setup_script", false, false],
      ["network_policy", true, true],
    ]);
    expect(setupRun.tasks.find((task) => task.id === "setup_script")).toMatchObject({
      output: null,
      skipReason: null,
    });
  });

  it("auto-completes the run after completing the last pending fatal task", () => {
    const { clientState, service } = createHarness({
      prepareTask: (task) =>
        task.id === "network_policy" ? task : completeTask(task),
    });

    service.completeTask("network_policy");

    const setupRun = requireSetupRun(clientState);
    expect(setupRun.status).toBe("completed");
    expect(setupRun.completedAt).not.toBeNull();
    expect(clientState.status).toBe("ready");
    expect(setupRun.tasks.find((task) => task.id === "network_policy")?.status)
      .toBe("completed");
  });

  it.each(["completeTask", "skipTask"] as const)(
    "%s does not complete the run while another task is pending",
    (transition) => {
      const { clientState, service } = createHarness({
        prepareTask: (task) =>
          task.id === "cloud_container" || task.id === "repository"
            ? task
            : completeTask(task),
      });

      if (transition === "completeTask") {
        service.completeTask("cloud_container");
      } else {
        service.skipTask("cloud_container");
      }

      const setupRun = requireSetupRun(clientState);
      expect(setupRun.status).toBe("running");
      expect(setupRun.completedAt).toBeNull();
      expect(setupRun.tasks.find((task) => task.id === "repository")?.status)
        .toBe("pending");
    },
  );

  it("does not fail the run when setup_script fails", () => {
    const { clientState, service } = createHarness({
      prepareTask: (task) =>
        task.id === "setup_script" ? task : completeTask(task),
    });

    service.failTask("setup_script", "script failed");

    const setupRun = requireSetupRun(clientState);
    expect(setupRun.status).toBe("completed");
    expect(setupRun.tasks.find((task) => task.id === "setup_script")?.status)
      .toBe("failed");
  });

  it.each([
    "network_policy",
    "cloud_container",
    "repository",
  ] as const)("fails the run when %s fails", (taskId) => {
    const { clientState, service } = createHarness();

    service.failTask(taskId, "fatal failure");

    const setupRun = requireSetupRun(clientState);
    expect(setupRun.status).toBe("failed");
    expect(clientState.status).toBe("setup_failed");
    expect(setupRun.completedAt).not.toBeNull();
    expect(setupRun.tasks.find((task) => task.id === taskId)?.status)
      .toBe("failed");
  });

  it("reopens a failed setup run when a failed task starts again", () => {
    const { clientState, service } = createHarness({
      prepareTask: (task) =>
        task.id === "cloud_container" ? failTask(task) : task,
    });
    clientState.sessionSetupRun = {
      ...requireSetupRun(clientState),
      status: "failed",
      completedAt: "2026-06-02T00:00:00.000Z",
    };

    service.startTask("cloud_container");

    const setupRun = requireSetupRun(clientState);
    const cloudContainerTask = setupRun.tasks.find((task) => task.id === "cloud_container");
    expect(setupRun.status).toBe("running");
    expect(clientState.status).toBe("preparing");
    expect(setupRun.completedAt).toBeNull();
    expect(cloudContainerTask?.status).toBe("running");
    expect(cloudContainerTask?.completedAt).toBeNull();
    expect(cloudContainerTask?.error).toBeNull();
  });

  it("does not reopen a failed setup run for a non-retryable failed task", () => {
    const { clientState, service } = createHarness({
      prepareTask: (task) =>
        task.id === "setup_script" ? failTask(task) : task,
    });
    clientState.sessionSetupRun = {
      ...requireSetupRun(clientState),
      status: "failed",
      completedAt: "2026-06-02T00:00:00.000Z",
    };

    service.startTask("setup_script");

    const setupRun = requireSetupRun(clientState);
    const setupScriptTask = setupRun.tasks.find((task) => task.id === "setup_script");
    expect(setupRun.status).toBe("failed");
    expect(setupRun.completedAt).not.toBeNull();
    expect(setupScriptTask?.status).toBe("failed");
  });

  it("preserves an older running setup run without a network policy task", () => {
    const { clientState, service } = createHarness({
      serverState: { finalNetworkPolicyApplied: false },
    });
    const setupRun = requireSetupRun(clientState);
    clientState.sessionSetupRun = {
      ...setupRun,
      tasks: setupRun.tasks.filter((task) => task.id !== "network_policy"),
    };

    service.repairBeforeProvisioning();

    expect(requireSetupRun(clientState).tasks.map((task) => task.id)).toEqual([
      "cloud_container",
      "session_connector",
      "repository",
      "setup_script",
    ]);
  });

  it("repairs older setup runs by backfilling retry metadata", () => {
    const { clientState, service } = createHarness();
    const setupRun = requireSetupRun(clientState);
    clientState.sessionSetupRun = {
      ...setupRun,
      tasks: setupRun.tasks.map((task) => {
        const { canRetry: _canRetry, ...legacyTask } = task;
        return legacyTask as SessionSetupTask;
      }),
    };

    service.repairBeforeProvisioning();

    expect(requireSetupRun(clientState).tasks.map((task) => [task.id, task.canRetry])).toEqual([
      ["cloud_container", true],
      ["session_connector", true],
      ["repository", true],
      ["setup_script", false],
      ["network_policy", true],
    ]);
  });

  it("leaves cloud container pending for targeted runtime migration recovery", () => {
    const { clientState, service } = createHarness({
      serverState: {
        startupToolchain: {
          contractHash: "legacy-hash",
          checkedAt: 1,
          results: [],
        },
      },
    });

    service.repairBeforeProvisioning();

    expect(requireSetupRun(clientState).tasks.find((task) => task.id === "cloud_container"))
      .toMatchObject({ status: "pending" });
  });

  it("does not insert a network policy task when its checkpoint exists", () => {
    const { clientState, service } = createHarness();
    const setupRun = requireSetupRun(clientState);
    clientState.sessionSetupRun = {
      ...setupRun,
      tasks: setupRun.tasks.filter((task) => task.id !== "network_policy"),
    };

    service.repairBeforeProvisioning();

    expect(requireSetupRun(clientState).tasks.some((task) => task.id === "network_policy"))
      .toBe(false);
  });

  it("includes the session connector task after cloud container", () => {
    const { clientState } = createHarness();

    expect(requireSetupRun(clientState).tasks.map((task) => task.id)).toEqual([
      "cloud_container",
      "session_connector",
      "repository",
      "setup_script",
      "network_policy",
    ]);
    expect(requireSetupRun(clientState).tasks.find((task) => task.id === "session_connector"))
      .toMatchObject({ isBlocking: true, canRetry: true });
  });

  it("preserves an older running setup run without a session connector task", () => {
    const { clientState, service } = createHarness({
      serverState: { finalNetworkPolicyApplied: false },
    });
    const setupRun = requireSetupRun(clientState);
    clientState.sessionSetupRun = {
      ...setupRun,
      tasks: setupRun.tasks.filter((task) => task.id !== "session_connector"),
    };

    service.repairBeforeProvisioning();

    expect(requireSetupRun(clientState).tasks.map((task) => task.id)).toEqual([
      "cloud_container",
      "repository",
      "setup_script",
      "network_policy",
    ]);
  });

  it("does not insert a session connector task when its checkpoint exists", () => {
    const { clientState, service } = createHarness({
      serverState: { sessionConnectorId: "conn-1", finalNetworkPolicyApplied: false },
    });
    const setupRun = requireSetupRun(clientState);
    clientState.sessionSetupRun = {
      ...setupRun,
      tasks: setupRun.tasks.filter((task) => task.id !== "session_connector"),
    };

    service.repairBeforeProvisioning();

    expect(requireSetupRun(clientState).tasks.some((task) => task.id === "session_connector"))
      .toBe(false);
  });

  it("does not backfill the connector task into an already completed run", () => {
    // Enabling the flags must not reopen finished sessions: they keep their
    // original credential paths, so the rollout only affects new sessions.
    const { clientState, service } = createHarness();
    const setupRun = requireSetupRun(clientState);
    clientState.sessionSetupRun = {
      ...setupRun,
      status: "completed",
      completedAt: "2026-06-02T00:00:00.000Z",
      tasks: setupRun.tasks
        .filter((task) => task.id !== "session_connector")
        .map(completeTask),
    };

    service.repairBeforeProvisioning();

    const repairedRun = requireSetupRun(clientState);
    expect(repairedRun.status).toBe("completed");
    expect(repairedRun.tasks.some((task) => task.id === "session_connector")).toBe(false);
  });

  it("preserves membership and order for failed historical runs", () => {
    const { clientState, service } = createHarness();
    const setupRun = requireSetupRun(clientState);
    clientState.sessionSetupRun = {
      ...setupRun,
      status: "failed",
      completedAt: "2026-06-02T00:00:00.000Z",
      tasks: setupRun.tasks
        .filter((task) => task.id !== "session_connector" && task.id !== "network_policy")
        .map((task) => task.id === "repository" ? failTask(task) : task),
    };
    const storedIds = requireSetupRun(clientState).tasks.map((task) => task.id);

    service.repairBeforeProvisioning();

    expect(requireSetupRun(clientState).tasks.map((task) => task.id)).toEqual(storedIds);
    expect(requireSetupRun(clientState).status).toBe("failed");
  });

});
