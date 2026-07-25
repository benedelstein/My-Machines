import type {
  AttachSessionOptions,
  NewExecSessionOptions,
  SpriteServerMessage} from "./types";
import {
  SessionInfoMessageSchema,
  SpriteServerMessageSchema,
} from "./types";
import { ConsoleLogger, type Logger } from "@repo/shared";

type NewExecSessionConfig = {
  mode: "exec";
  command: string;
  args: string[];
  options: NewExecSessionOptions;
};

type AttachSessionConfig = {
  mode: "attach";
  sessionId: string;
  options: AttachSessionOptions;
};

/**
 * Stream ID for the binary protocol
 */
export enum StreamID {
  Stdin = 0,
  Stdout = 1,
  Stderr = 2,
  Exit = 3,
  StdinEOF = 4,
}

type WorkersSessionConfig = NewExecSessionConfig | AttachSessionConfig;

const WEBSOCKET_CLOSED_OK_CODE = 1000;
const WEBSOCKET_CLOSED_GOING_AWAY_CODE = 1001;

/**
 * Websocket session client compatible with cloudflare workers api.
 * The @fly/sprites package is designed for node js, which uses an incompatible websocket API.
 */
export class SpriteWebsocketSession {
  private readonly textEncoder = new TextEncoder();
  // Separate decoders per stream so partial multi-byte UTF-8 sequences split
  // across WebSocket frames are stitched together correctly (via stream: true).
  // Sharing a single decoder would cross-contaminate stdout and stderr streams.
  private readonly stdoutDecoder = new TextDecoder();
  private readonly stderrDecoder = new TextDecoder();
  private readonly ttyDecoder = new TextDecoder();
  private ws: WebSocket | null = null;
  private readonly spriteName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly config: WorkersSessionConfig;
  private ttyMode: boolean;
  private exitCode: number | null = null;
  private started = false;
  /** Session has exited */
  private done = false;
  private terminalError: Error | null = null;
  private idleTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingWaiters = new Set<{
    resolve: (code: number) => void;
    reject: (error: Error) => void;
  }>();

  private stdoutHandlers: Set<(data: string) => void> = new Set();
  private stderrHandlers: Set<(data: string) => void> = new Set();
  private exitHandlers: Set<(code: number) => void> = new Set();
  private errorHandlers: Set<(error: Error) => void> = new Set();
  private serverMessageHandlers: Set<(msg: SpriteServerMessage) => void> =
    new Set();

  private readonly logger: Logger;

  constructor(
    spriteName: string,
    apiKey: string,
    baseUrl: string,
    config: WorkersSessionConfig,
    logger?: Logger,
  ) {
    this.spriteName = spriteName;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.config = config;
    this.ttyMode = config.mode === "exec" ? Boolean(config.options.tty) : false;
    this.logger = logger ?? new ConsoleLogger({ format: "pretty" }, "SpriteWebsocketSession.ts");
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("SpriteWebsocketSession already started");
    }
    this.started = true;

    const wsUrl = this.createWsUrl();

    if (this.config.mode === "exec" && (this.config.options.stdin ?? true)) {
      wsUrl.searchParams.set("stdin", "true");
    }

    if (this.config.options.env) {
      for (const [key, value] of Object.entries(this.config.options.env)) {
        wsUrl.searchParams.append("env", `${key}=${value}`);
      }
    }

    if (this.config.options.detachable) {
      wsUrl.searchParams.set("detachable", "true");
    }

    // Workers fetch upgrade uses https:// (not wss://) - Workers handles the protocol
    const response = await fetch(wsUrl.toString(), {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    // Workers WebSocket from fetch response
    const ws = response.webSocket;
    if (!ws) {
      const body = await response.text();
      this.logger.error("WebSocket upgrade failed", {
        fields: { status: response.status, body },
      });
      throw new Error(
        `Server didn't accept WebSocket connection: ${response.status} - ${body}`,
      );
    }

    // Accept the WebSocket connection to handle it in JS
    ws.accept();
    this.ws = ws;

    // For attach mode, wait for session_info before setting up the main message handler.
    // We cannot decode binary data until we know the TTY mode.
    if (this.config.mode === "attach") {
      await this.waitForSessionInfo();
    }

    ws.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    // this signals that the websocket closed, not that the process on the vm finished.
    ws.addEventListener("close", (event) => {
      this.handleWSClose(event);
    });

    ws.addEventListener("error", (error) => {
      if (this.done) {
        this.logger.debug("Ignoring websocket error after terminal state", {
          error: error.message,
        });
        return;
      }

      this.logger.error("WebSocket error", {
        error: error.message,
      });
      this.finalizeTransportFailure(new Error("WebSocket error"), {
        closeCode: WEBSOCKET_CLOSED_GOING_AWAY_CODE,
      });
    });

    this.resetIdleTimeout();
  }

  /**
   * Waits for the session_info message when attaching to an existing session.
   * Uses a temporary self-removing listener so the main message handler is not
   * active until ttyMode is known. Binary messages (historical output) are
   * ignored since they cannot be decoded without knowing TTY mode.
   */
  private waitForSessionInfo(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.ws?.removeEventListener("message", messageHandler);
        this.ws?.removeEventListener("close", closeHandler);
        this.ws?.removeEventListener("error", errorHandler);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout waiting for session_info"));
      }, 10_000);

      const closeHandler = () => {
        cleanup();
        this.logger.error("WebSocket closed before session_info");
        reject(new Error("WebSocket closed before session_info"));
      };

      const errorHandler = () => {
        cleanup();
        this.logger.error("WebSocket error before session_info");
        reject(new Error("WebSocket error before session_info"));
      };

      const messageHandler = (event: MessageEvent) => {
        // Binary messages before session_info are historical output - ignore until TTY mode is known
        if (typeof event.data !== "string") { return; }
        try {
          const message: unknown = JSON.parse(event.data);
          const result = SessionInfoMessageSchema.safeParse(message);
          if (result.success) {
            cleanup();
            this.logger.info("Process info received", {
              fields: { tty: result.data.tty },
            });
            this.ttyMode = result.data.tty;
            this.dispatchServerMessage(result.data);
            resolve();
            return;
          }
          // Forward non-session_info messages to server message handlers
          this.dispatchServerMessage(message);
        } catch {
          // Non-JSON - ignore during session_info wait
        }
      };

      this.ws!.addEventListener("message", messageHandler);
      this.ws!.addEventListener("close", closeHandler);
      this.ws!.addEventListener("error", errorHandler);
    });
  }

  private createWsUrl(): URL {
    switch (this.config.mode) {
      case "exec": {
        const wsUrl = new URL(
          `${this.baseUrl}/v1/sprites/${this.spriteName}/exec`,
        );
        wsUrl.searchParams.append("cmd", this.config.command);
        for (const arg of this.config.args) {
          wsUrl.searchParams.append("cmd", arg);
        }
        wsUrl.searchParams.set("path", this.config.command);

        if (this.config.options.cwd) {
          wsUrl.searchParams.set("dir", this.config.options.cwd);
        }

        if (this.config.options.tty) {
          wsUrl.searchParams.set("tty", "true");
          if (typeof this.config.options.cols === "number") {
            wsUrl.searchParams.set("cols", String(this.config.options.cols));
          }
          if (typeof this.config.options.rows === "number") {
            wsUrl.searchParams.set("rows", String(this.config.options.rows));
          }
        }

        if (this.config.options.maxRunAfterDisconnect) {
          wsUrl.searchParams.set(
            "max_run_after_disconnect",
            this.config.options.maxRunAfterDisconnect,
          );
        }

        return wsUrl;
      }
      case "attach": {
        const wsUrl = new URL(
          `${this.baseUrl}/v1/sprites/${this.spriteName}/exec/${this.config.sessionId}`,
        );

        if (this.config.options.cwd) {
          wsUrl.searchParams.set("dir", this.config.options.cwd);
        }

        return wsUrl;
      }
    }
  }

  private getBinaryPayload(data: unknown): Uint8Array | null {
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }

    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    return null;
  }

  private getIdleTimeoutMs(): number | null {
    const idleTimeoutMs = this.config.options.idleTimeoutMs;
    if (
      typeof idleTimeoutMs !== "number" ||
      !Number.isFinite(idleTimeoutMs) ||
      idleTimeoutMs <= 0
    ) {
      return null;
    }

    return idleTimeoutMs;
  }

  private clearIdleTimeout(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
  }

  private resetIdleTimeout(): void {
    this.clearIdleTimeout();

    const idleTimeoutMs = this.getIdleTimeoutMs();
    if (idleTimeoutMs === null || this.done) {
      return;
    }

    this.idleTimeout = setTimeout(() => {
      this.logger.error("WebSocket idle timeout", {
        fields: { idleTimeoutMs },
      });
      this.finalizeTransportFailure(
        new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`),
        { closeCode: WEBSOCKET_CLOSED_GOING_AWAY_CODE },
      );
    }, idleTimeoutMs);
  }

  private getOpenWebSocket(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    return this.ws;
  }

  private getStreamName(streamId: number): string {
    switch (streamId) {
      case StreamID.Stdin:
        return "stdin";
      case StreamID.Stdout:
        return "stdout";
      case StreamID.Stderr:
        return "stderr";
      case StreamID.Exit:
        return "exit";
      case StreamID.StdinEOF:
        return "stdin_eof";
      default:
        return `unknown(${streamId})`;
    }
  }

  private getPayloadPreview(text: string): string {
    const normalizedText = text.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    return normalizedText.length > 120
      ? `${normalizedText.slice(0, 120)}...`
      : normalizedText;
  }

  private sendBinaryFrame(streamId: StreamID, payload?: Uint8Array): void {
    const framePayload = payload ?? new Uint8Array(0);
    const frame = new Uint8Array(1 + framePayload.length);
    frame[0] = streamId;
    frame.set(framePayload, 1);
    this.getOpenWebSocket().send(frame);
  }

  private handleMessage(data: unknown): void {
    if (this.done) {
      return;
    }

    this.resetIdleTimeout();
    const binaryPayload = this.getBinaryPayload(data);

    if (this.ttyMode) {
      // TTY mode: binary = raw stdout, string = JSON control messages
      if (binaryPayload) {
        const text = this.ttyDecoder.decode(binaryPayload, { stream: true });
        this.stdoutHandlers.forEach((h) => h(text));
      } else if (typeof data === "string") {
        try {
          const msg: unknown = JSON.parse(data);
          this.dispatchServerMessage(msg);
        } catch {
          // Non-JSON string - treat as stdout
          this.stdoutHandlers.forEach((h) => h(data));
        }
      }
    } else {
      // Non-TTY mode: stream-based binary protocol
      if (binaryPayload) {
        if (binaryPayload.length === 0) {
          return;
        }

        const streamId = binaryPayload[0]!;
        const payload = binaryPayload.subarray(1);

        switch (streamId) {
          case StreamID.Stdout: {
            // stream: true retains partial UTF-8 sequences across WebSocket frames
            const text = this.stdoutDecoder.decode(payload, { stream: true });
            this.stdoutHandlers.forEach((h) => h(text));
            break;
          }
          case StreamID.Stderr: {
            const text = this.stderrDecoder.decode(payload, { stream: true });
            this.stderrHandlers.forEach((h) => h(text));
            break;
          }
          case StreamID.Exit: {
            this.finalizeExit(payload.length > 0 ? payload[0]! : 0);
            break;
          }
        }
      } else if (typeof data === "string") {
        // JSON server messages in non-TTY mode
        try {
          const msg: unknown = JSON.parse(data);
          this.dispatchServerMessage(msg);
        } catch {
          // Non-JSON string - unexpected in non-TTY mode
        }
      }
    }
  }

  /**
   * Handles websocket close
   * @param event
   */
  private handleWSClose(event: CloseEvent): void {
    this.clearIdleTimeout();
    this.ws = null;

    if (this.done) {
      return;
    }

    const reasonSuffix = event.reason ? ` reason=${event.reason}` : "";
    this.finalizeTransportFailure(
      new Error(
        `WebSocket closed before receiving process exit: code=${event.code}${reasonSuffix}`,
      ),
    );
  }

  private dispatchServerMessage(msg: unknown): void {
    const result = SpriteServerMessageSchema.safeParse(msg);
    if (!result.success) {
      this.logger.warn("[SpriteWebsocketSession] Unknown server message", {
        fields: {
          message: JSON.stringify(msg),
          issues: JSON.stringify(result.error.format()),
        },
      });
      return;
    }

    const parsed = result.data;
    this.serverMessageHandlers.forEach((h) => h(parsed));

    if (parsed.type === "exit") {
      this.logger.debug("Received exit message");
      this.finalizeExit(parsed.exit_code);
    }
  }

  private finalizeExit(exitCode: number): void {
    if (this.done) {
      // the sprite may send an exit message both via ExitMessage json and a binary frame - `done` makes this idempotent.
      if (this.exitCode !== null && this.exitCode !== exitCode) {
        this.logger.warn("Ignoring duplicate exit code", {
          fields: {
            exitCode,
            recordedExitCode: this.exitCode,
          },
        });
      }
      return;
    }

    this.logger.debug("Finalizing exit", {
      fields: { exitCode },
    });
    this.done = true;
    this.exitCode = exitCode;
    this.clearIdleTimeout();
    this.resolvePendingWaits(exitCode);
    this.exitHandlers.forEach((handler) => handler(exitCode));
    this.close();
  }

  /**
   * Call when websocket transport fails or the WS closes without a clean
   * process exit frame. Notifies `onError` handlers, rejects any `.wait()`
   * waiters, and optionally closes the socket with the given code.
   *
   * Re-entry is safe: the `done` guard makes this idempotent, and every
   * normal-termination path sets `done = true` before calling `close()`,
   * so the follow-up close event no-ops in `handleWSClose`.
   */
  private finalizeTransportFailure(
    error: Error,
    options: { closeCode?: number } = {},
  ): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.terminalError = error;
    this.clearIdleTimeout();

    this.errorHandlers.forEach((handler) => handler(error));
    this.rejectPendingWaits(error);

    if (typeof options.closeCode === "number") {
      this.close(options.closeCode);
    }
  }

  private resolvePendingWaits(exitCode: number): void {
    for (const waiter of this.pendingWaiters) {
      waiter.resolve(exitCode);
    }
    this.pendingWaiters.clear();
  }

  private rejectPendingWaits(error: Error): void {
    for (const waiter of this.pendingWaiters) {
      waiter.reject(error);
    }
    this.pendingWaiters.clear();
  }

  //==========================================================================================================
  // Event handlers
  //==========================================================================================================

  onStdout(handler: (data: string) => void): () => void {
    this.stdoutHandlers.add(handler);
    return () => this.stdoutHandlers.delete(handler);
  }

  onStderr(handler: (data: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return () => this.stderrHandlers.delete(handler);
  }

  onExit(handler: (code: number) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onServerMessage(handler: (msg: SpriteServerMessage) => void): () => void {
    this.serverMessageHandlers.add(handler);
    return () => this.serverMessageHandlers.delete(handler);
  }

  // ==========================================================================================================
  // Public session commands
  // ==========================================================================================================

  /**
   * Write data to stdin
   * @param data
   */
  write(data: string): void {
    const textBytes = this.textEncoder.encode(data);

    if (this.ttyMode) {
      // TTY mode: send raw text
      this.getOpenWebSocket().send(textBytes);
    } else {
      this.sendBinaryFrame(StreamID.Stdin, textBytes);
    }
  }

  closeStdin(): void {
    if (this.ttyMode) {
      // TTY mode: send Ctrl+D (EOT character)
      this.getOpenWebSocket().send(this.textEncoder.encode("\x04"));
    } else {
      this.sendBinaryFrame(StreamID.StdinEOF);
    }
  }
  
  /**
   * Waits for a websocket exec to complete synchronously.
   * @returns a promise that resolves to the exit code of the session
   */
  wait(): Promise<number> {
    if (this.done) {
      if (this.exitCode !== null) {
        return Promise.resolve(this.exitCode);
      }
      return Promise.reject(
        this.terminalError ?? new Error("Session ended without an exit code"),
      );
    }

    return new Promise((resolve, reject) => {
      this.pendingWaiters.add({ resolve, reject });
    });
  }

  close(code: number = WEBSOCKET_CLOSED_OK_CODE): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(code, "");
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.ttyMode) { throw new Error("Resize only supported in TTY mode"); }

    this.getOpenWebSocket().send(
      JSON.stringify({ type: "resize", cols, rows }),
    );
  }

  signal(signal: string): void {
    this.getOpenWebSocket().send(JSON.stringify({ type: "signal", signal }));
  }

  get isConnected(): boolean {
    return this.ws !== null;
  }

  /**
   * Get the current TTY mode
   */
  get isTTY(): boolean {
    return this.ttyMode;
  }

  /**
   * Check if the command is done
   */
  get isDone(): boolean {
    return this.done;
  }
}
