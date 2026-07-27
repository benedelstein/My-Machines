import type {
  BaseSessionSetupTask,
  ClientState,
  SessionSetupRun,
  SessionSetupTask,
  SessionSetupTaskId,
  SessionSetupTaskOutput,
  StartupScriptSetupTaskSkipReason,
} from "@repo/shared";
import type { ServerState } from "../repositories/server-state.repository";

const SETUP_TASK_DEFINITIONS = {
  cloud_container: { isBlocking: true, canRetry: true },
  session_connector: { isBlocking: true, canRetry: true },
  repository: { isBlocking: true, canRetry: true },
  setup_script: { isBlocking: false, canRetry: false },
  network_policy: { isBlocking: true, canRetry: true },
} as const satisfies Record<SessionSetupTaskId, {
  isBlocking: boolean;
  canRetry: boolean;
}>;

const CREATE_SETUP_TASK_IDS = Object.keys(SETUP_TASK_DEFINITIONS) as SessionSetupTaskId[];

export interface SessionSetupRunServiceDeps {
  getServerState: () => ServerState;
  getClientState: () => ClientState;
  updateRunState: (setupRun: SessionSetupRun) => void;
}

/**
 * Owns the public setup checklist state for a SessionAgentDO instance.
 * Callers report task transitions; this service patches ClientState.
 */
export class SessionSetupRunService {
  private readonly getServerState: SessionSetupRunServiceDeps["getServerState"];
  private readonly getClientState: SessionSetupRunServiceDeps["getClientState"];
  private readonly updateRunState: SessionSetupRunServiceDeps["updateRunState"];

  constructor(deps: SessionSetupRunServiceDeps) {
    this.getServerState = deps.getServerState;
    this.getClientState = deps.getClientState;
    this.updateRunState = deps.updateRunState;
  }

  buildRun(): SessionSetupRun {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      status: "running",
      startedAt: now,
      completedAt: null,
      tasks: CREATE_SETUP_TASK_IDS.map(createSetupTask),
    };
  }

  startTask(taskId: SessionSetupTaskId): void {
    const setupRun = this.getClientState().sessionSetupRun;
    if (!setupRun) { return; }
    const task = setupRun.tasks.find((candidate) => candidate.id === taskId);
    if (!task) { return; }
    if (setupRun.status === "failed" && task.status === "failed" && task.canRetry) {
      const now = new Date().toISOString();
      const retryTask = updateSetupTask(task, {
        status: "running",
        startedAt: now,
        completedAt: null,
        error: null,
      });
      this.updateRun({
        ...replaceSetupTask(setupRun, retryTask),
        status: "running",
        completedAt: null,
      });
      return;
    }

    const updatedRun = this.updateTask(taskId, (task, now) => {
      if (isTerminalSetupTask(task)) { return task; }
      return updateSetupTask(task, {
        status: "running",
        startedAt: task.startedAt ?? now,
        completedAt: null,
        error: null,
      });
    });
    if (!updatedRun) { return; }
    this.updateRun(updatedRun);
  }

  completeTask(taskId: SessionSetupTaskId, output?: SessionSetupTaskOutput): void {
    const updatedRun = this.updateTask(taskId, (task, now) => {
      if (task.status === "completed") { return task; }
      if (task.status === "failed" || task.status === "skipped") { return task; }
      const nextTask = updateSetupTask(task, {
        status: "completed",
        startedAt: task.startedAt ?? now,
        completedAt: now,
        error: null,
      });
      return nextTask.id === "setup_script"
        ? { ...nextTask, output: output ?? nextTask.output, skipReason: null }
        : nextTask;
    });
    if (!updatedRun) { return; }
    this.updateRun(this.completeRunIfReady(updatedRun));
  }

  failTask(
    taskId: SessionSetupTaskId,
    error: string,
    output?: SessionSetupTaskOutput,
  ): void {
    const setupRun = this.updateTask(taskId, (task, now) => {
      if (task.status === "completed" || task.status === "skipped") { return task; }
      const nextTask = updateSetupTask(task, {
        status: "failed",
        startedAt: task.startedAt ?? now,
        completedAt: now,
        error,
      });
      return nextTask.id === "setup_script"
        ? { ...nextTask, output: output ?? nextTask.output, skipReason: null }
        : nextTask;
    });
    if (!setupRun) { return; }
    this.updateRun(this.reconcileFailedTask(setupRun, taskId));
  }

  skipTask(taskId: SessionSetupTaskId, skipReason?: StartupScriptSetupTaskSkipReason): void {
    const setupRun = this.updateTask(taskId, (task, now) => {
      if (isTerminalSetupTask(task)) { return task; }
      const nextTask = updateSetupTask(task, {
        status: "skipped",
        startedAt: task.startedAt ?? now,
        completedAt: now,
        error: null,
      });
      return nextTask.id === "setup_script"
        ? { ...nextTask, skipReason: skipReason ?? null }
        : nextTask;
    });
    if (!setupRun) { return; }
    this.updateRun(this.completeRunIfReady(setupRun));
  }

  completeRun(): void {
    const setupRun = this.getClientState().sessionSetupRun;
    if (!setupRun || setupRun.status !== "running") { return; }
    const nextRun = this.completeRunIfReady(setupRun);
    if (nextRun === setupRun) { return; }
    this.updateRun(nextRun);
  }

  /**
   * Recovers setup run state from saved state when the DO restarts.
   *
   * Only an in-progress run is repaired. A run that already reached a terminal
   * status is never reopened, so a session provisioned before
   * `session_connector` existed does not gain the task retroactively and keeps
   * its original webhook and git credential paths for the rest of its life.
   * Enabling the connector flags therefore changes new sessions only.
   */
  repairOnStart(): void {
    const setupRun = this.getClientState().sessionSetupRun;
    if (!setupRun) { return; }
    const currentRun = normalizeSetupTaskMetadata(setupRun);
    if (currentRun.status !== "running") {
      if (currentRun !== setupRun) {
        this.updateRun(currentRun);
      }
      return;
    }

    const serverState = this.getServerState();
    const now = new Date().toISOString();
    let repairableRun = ensureNetworkPolicyTaskPresent(currentRun, serverState, now);
    repairableRun = ensureSessionConnectorTaskPresent(repairableRun, serverState, now);
    const repairedTasks = repairableRun.tasks.map((task): SessionSetupTask => {
      if (isTerminalSetupTask(task)) { return task; }
      switch (task.id) {
        case "cloud_container":
          return serverState.spriteName && serverState.startupToolchain
            ? completeSetupTaskForRepair(task, now)
            : task;
        case "session_connector":
          return serverState.sessionConnectorId
            ? completeSetupTaskForRepair(task, now)
            : task;
        case "repository":
          return serverState.repoCloned ? completeSetupTaskForRepair(task, now) : task;
        case "setup_script":
          return serverState.startupScriptCompleted
            ? completeSetupTaskForRepair(task, now)
            : task;
        case "network_policy":
          return serverState.finalNetworkPolicyApplied
            ? completeSetupTaskForRepair(task, now)
            : task;
      }
    });

    this.updateRun(this.completeRunIfReady({ ...repairableRun, tasks: repairedTasks }));
  }

  private updateTask(
    taskId: SessionSetupTaskId,
    updater: (
      task: SessionSetupTask,
      now: string,
    ) => SessionSetupTask,
  ): SessionSetupRun | null {
    const setupRun = this.getClientState().sessionSetupRun;
    if (!setupRun || setupRun.status !== "running") { return null; }
    const task = setupRun.tasks.find((candidate) => candidate.id === taskId);
    if (!task) { return null; }

    const now = new Date().toISOString();
    const nextTask = updater(task, now);
    if (nextTask === task) { return null; }
    return replaceSetupTask(setupRun, nextTask);
  }

  private updateRun(setupRun: SessionSetupRun): void {
    this.updateRunState(setupRun);
  }

  private completeRunIfReady(setupRun: SessionSetupRun): SessionSetupRun {
    if (setupRun.status !== "running") { return setupRun; }
    if (!setupRun.tasks.every(isTerminalSetupTask)) { return setupRun; }
    if (setupRun.tasks.some((task) => task.status === "failed" && task.isBlocking)) {
      return setupRun;
    }
    return {
      ...setupRun,
      status: "completed",
      completedAt: new Date().toISOString(),
    };
  }

  private reconcileFailedTask(
    setupRun: SessionSetupRun,
    taskId: SessionSetupTaskId,
  ): SessionSetupRun {
    const failedTask = setupRun.tasks.find((task) => task.id === taskId);
    if (!failedTask) { return setupRun; }
    if (!failedTask.isBlocking) {
      return this.completeRunIfReady(setupRun);
    }
    return {
      ...setupRun,
      status: "failed",
      completedAt: failedTask.completedAt ?? new Date().toISOString(),
    };
  }
}

/**
 * Returns true if the setup task is terminal (completed, failed, or skipped).
 * @param task - The setup task to check.
 * @returns True if the task is terminal (completed, failed, or skipped).
 */
export function isTerminalSetupTask(task: SessionSetupTask): boolean {
  switch (task.status) {
    case "completed":
    case "failed":
    case "skipped":
      return true;
    case "pending":
    case "running":
      return false;
    default: {
      const exhaustiveCheck: never = task.status;
      throw new Error(`Unhandled setup task status: ${exhaustiveCheck}`);
    }
  }
}

function createSetupTask(taskId: SessionSetupTaskId): SessionSetupTask {
  const baseTask = createBaseSetupTask(taskId);
  if (taskId === "setup_script") {
    return {
      ...baseTask,
      output: null,
      skipReason: null,
    } as SessionSetupTask;
  }
  return baseTask as SessionSetupTask;
}

function createBaseSetupTask(taskId: SessionSetupTaskId): BaseSessionSetupTask & {
  status: "pending";
  startedAt: null;
  completedAt: null;
  error: null;
} {
  const definition = SETUP_TASK_DEFINITIONS[taskId];
  return {
    id: taskId,
    isBlocking: definition.isBlocking,
    canRetry: definition.canRetry,
    status: "pending",
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

function updateSetupTask(
  task: SessionSetupTask,
  fields: Pick<SessionSetupTask, "status" | "startedAt" | "completedAt" | "error">,
): SessionSetupTask {
  switch (task.id) {
    case "cloud_container":
    case "session_connector":
    case "repository":
    case "network_policy":
    case "setup_script":
      return { ...task, ...fields };
    default: {
      const exhaustiveCheck: never = task;
      throw new Error(`Unhandled setup task: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function ensureNetworkPolicyTaskPresent(
  setupRun: SessionSetupRun,
  serverState: ServerState,
  now: string,
): SessionSetupRun {
  if (setupRun.tasks.some((task) => task.id === "network_policy")) {
    return setupRun;
  }

  const networkPolicyTask = serverState.finalNetworkPolicyApplied
    ? completeSetupTaskForRepair(createSetupTask("network_policy"), now)
    : createSetupTask("network_policy");
  const tasks = [...setupRun.tasks];
  tasks.push(networkPolicyTask);
  return { ...setupRun, tasks };
}

/**
 * Back-fills the session_connector task into runs created before the flag
 * was enabled. Inserted after cloud_container so a mid-provision restart
 * mints the connector before the repository and network-policy steps.
 */
function ensureSessionConnectorTaskPresent(
  setupRun: SessionSetupRun,
  serverState: ServerState,
  now: string,
): SessionSetupRun {
  if (setupRun.tasks.some((task) => task.id === "session_connector")) {
    return setupRun;
  }

  const connectorTask = serverState.sessionConnectorId
    ? completeSetupTaskForRepair(createSetupTask("session_connector"), now)
    : createSetupTask("session_connector");
  const tasks = [...setupRun.tasks];
  const cloudContainerIndex = tasks.findIndex((task) => task.id === "cloud_container");
  tasks.splice(cloudContainerIndex + 1, 0, connectorTask);
  return { ...setupRun, tasks };
}

function normalizeSetupTaskMetadata(setupRun: SessionSetupRun): SessionSetupRun {
  let changed = false;
  const tasks = setupRun.tasks.map((task) => {
    const storedTask = task as SessionSetupTask & { canRetry?: boolean };
    if (typeof storedTask.canRetry === "boolean") {
      return task;
    }
    changed = true;
    return {
      ...task,
      canRetry: SETUP_TASK_DEFINITIONS[task.id].canRetry,
    } as SessionSetupTask;
  });
  return changed ? { ...setupRun, tasks } : setupRun;
}

function completeSetupTaskForRepair(
  task: SessionSetupTask,
  completedAt: string,
): SessionSetupTask {
  return updateSetupTask(task, {
    status: "completed",
    startedAt: task.startedAt ?? completedAt,
    completedAt,
    error: null,
  });
}

function replaceSetupTask(
  setupRun: SessionSetupRun,
  task: SessionSetupTask,
): SessionSetupRun {
  return {
    ...setupRun,
    tasks: setupRun.tasks.map((candidate) =>
      candidate.id === task.id ? task : candidate,
    ),
  };
}
