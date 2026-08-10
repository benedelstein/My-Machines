import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleLogger } from "@repo/shared";
import { WorkersSpriteClient } from "../src/workers-sprite.client";

const testLogger = new ConsoleLogger({ format: "pretty" }, "workers-sprite-client.test.ts");

const encoder = new TextEncoder();

describe("WorkersSpriteClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams WebSocket exec chunks while returning accumulated output", async () => {
    const client = new WorkersSpriteClient(
      "sprite-1",
      "sprites-key",
      "https://api.sprites.test",
      testLogger,
    );
    let stdoutHandler: ((data: string) => void) | null = null;
    let stderrHandler: ((data: string) => void) | null = null;
    const session = {
      onStdout: vi.fn((handler: (data: string) => void) => {
        stdoutHandler = handler;
      }),
      onStderr: vi.fn((handler: (data: string) => void) => {
        stderrHandler = handler;
      }),
      start: vi.fn(async () => {
        stdoutHandler?.("hello ");
        stderrHandler?.("warn\n");
        stdoutHandler?.("world\n");
      }),
      wait: vi.fn(async () => 0),
    };
    vi.spyOn(client, "createSession").mockReturnValue(
      session as unknown as ReturnType<WorkersSpriteClient["createSession"]>,
    );
    const onStdout = vi.fn();
    const onStderr = vi.fn();

    const result = await client.execWs("echo hello", {
      cwd: "/workspace",
      env: { FOO: "bar" },
      idleTimeoutMs: 123,
      onStdout,
      onStderr,
    });

    expect(client.createSession).toHaveBeenCalledWith("sh", ["-c", "echo hello"], {
      env: { FOO: "bar" },
      cwd: "/workspace",
      idleTimeoutMs: 123,
      tty: false,
      stdin: false,
    });
    expect(onStdout).toHaveBeenNthCalledWith(1, "hello ");
    expect(onStdout).toHaveBeenNthCalledWith(2, "world\n");
    expect(onStderr).toHaveBeenCalledWith("warn\n");
    expect(result).toEqual({
      stdout: "hello world",
      stderr: "warn",
      exitCode: 0,
    });
  });

  it("returns a nonzero WebSocket exit code with separate stdout and stderr", async () => {
    const webSocket = new FakeWebSocket([
      createFrame(1, "out\n"),
      createFrame(2, "err\n"),
      new Uint8Array([3, 7]),
    ]);
    vi.stubGlobal("WebSocket", { OPEN: FakeWebSocket.OPEN });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 101,
      webSocket,
    })) as unknown as typeof fetch);
    const client = new WorkersSpriteClient(
      "sprite-1",
      "sprites-key",
      "https://api.sprites.test",
      testLogger,
    );

    await expect(client.execWs("exit 7")).resolves.toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 7,
    });
  });

  it("rejects when the WebSocket closes before an exit frame", async () => {
    const webSocket = new FakeWebSocket([
      createFrame(1, "incomplete\n"),
    ], { closeBeforeExit: true });
    vi.stubGlobal("WebSocket", { OPEN: FakeWebSocket.OPEN });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 101,
      webSocket,
    })) as unknown as typeof fetch);
    const client = new WorkersSpriteClient(
      "sprite-1",
      "sprites-key",
      "https://api.sprites.test",
      testLogger,
    );

    await expect(client.execWs("echo incomplete")).rejects.toThrow(
      "WebSocket closed before receiving process exit",
    );
  });

  it("returns parsed network-policy apply and readback responses", async () => {
    const rules = [
      { domain: "api.github.com", action: "allow" as const },
      { domain: "*", action: "deny" as const },
    ];
    const fetchSpy = vi.fn<typeof fetch>().mockImplementation(async () => {
      return Response.json({ rules });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const client = new WorkersSpriteClient(
      "sprite-1",
      "sprites-key",
      "https://api.sprites.test",
      testLogger,
    );

    await expect(client.setNetworkPolicy(rules)).resolves.toEqual(rules);
    await expect(client.getNetworkPolicy()).resolves.toEqual(rules);

    expect(fetchSpy).toHaveBeenNthCalledWith(1,
      "https://api.sprites.test/v1/sprites/sprite-1/policy/network",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(2,
      "https://api.sprites.test/v1/sprites/sprite-1/policy/network",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

function createFrame(streamId: number, payload: string): Uint8Array {
  const payloadBytes = encoder.encode(payload);
  const frame = new Uint8Array(payloadBytes.length + 1);
  frame[0] = streamId;
  frame.set(payloadBytes, 1);
  return frame;
}

class FakeWebSocket {
  static readonly OPEN = 1;

  readyState = FakeWebSocket.OPEN;
  private readonly closeBeforeExit: boolean;
  private readonly frames: Uint8Array[];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(frames: Uint8Array[], options: { closeBeforeExit?: boolean } = {}) {
    this.frames = frames;
    this.closeBeforeExit = options.closeBeforeExit ?? false;
  }

  accept(): void {
    queueMicrotask(() => {
      for (const frame of this.frames) {
        this.dispatch("message", { data: frame });
      }
      if (this.closeBeforeExit) {
        this.close(1006);
      }
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.dispatch("close", { code, reason: "" });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
