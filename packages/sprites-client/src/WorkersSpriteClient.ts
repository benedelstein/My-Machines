import type { Logger } from "@repo/shared";
import { SpriteWebsocketSession } from "./SpriteWebsocketSession";
import type {
  AttachSessionOptions,
  ExecResult,
  NewExecSessionOptions,
} from "./types";
import { SpritesError } from "./types";

export interface NetworkPolicyRule {
  domain: string;
  action: "allow" | "deny";
}

export interface SpriteUrlSettings {
  auth: "public" | "sprite";
}

export interface SpriteInfoResponse {
  name: string;
  url?: string;
  url_settings?: { auth: string };
  status?: string;
}

export class WorkersSpriteClient {
  private baseUrl: string;
  private apiKey: string;
  private readonly logger: Logger;
  public readonly name: string;

  constructor(name: string, apiKey: string, baseUrl: string, logger: Logger) {
    this.name = name;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  /**
   * Execute a command on the sprite via a WebSocket session.
   *
   * Keep command execution on WebSockets. The Sprite HTTP exec response uses
   * channel-prefixed binary records, but Fetch ReadableStream chunks are
   * arbitrary transport chunks rather than protocol frame boundaries. Records
   * can therefore be split or coalesced (we observed stdout and the exit record
   * in one chunk), making exit detection ambiguous. WebSocket message boundaries
   * preserve the records. Do not reintroduce HTTP exec unless Sprites documents
   * a self-framing HTTP response format.
   *
   * @param command the command to execute
   * @param options the options for the command
   * @returns a promise that resolves to the result of the command
   */
  async execWs(
    command: string,
    options: {
      env?: Record<string, string>;
      cwd?: string;
      idleTimeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    } = {},
  ): Promise<ExecResult> {
    const session = this.createSession("sh", ["-c", command], {
      env: options.env,
      cwd: options.cwd,
      idleTimeoutMs: options.idleTimeoutMs,
      tty: false,
      stdin: false,
    });

    let stdout = "";
    let stderr = "";
    session.onStdout((data) => {
      stdout += data;
      options.onStdout?.(data);
    });
    session.onStderr((data) => {
      stderr += data;
      options.onStderr?.(data);
    });

    await session.start();
    const exitCode = await session.wait();
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode };
  }

  createSession(
    command: string,
    args: string[] = [],
    options: NewExecSessionOptions = {},
  ): SpriteWebsocketSession {
    return new SpriteWebsocketSession(this.name, this.apiKey, this.baseUrl, {
      mode: "exec",
      command,
      args,
      options,
    }, this.logger);
  }

  attachSession(
    sessionId: string,
    options: AttachSessionOptions = {},
  ): SpriteWebsocketSession {
    return new SpriteWebsocketSession(this.name, this.apiKey, this.baseUrl, {
      mode: "attach",
      sessionId,
      options,
    }, this.logger);
  }

  async setNetworkPolicy(rules: NetworkPolicyRule[]): Promise<void> {
    const url = `${this.baseUrl}/v1/sprites/${this.name}/policy/network`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rules }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new SpritesError(
        `Failed to set network policy: ${response.status}`,
        response.status,
        text,
      );
    }
  }

  /**
   * Kills a session/processs running on the sprite.
   * @param sessionId Sprite process ID to kill
   * @param signal Signal to send to the process (default: SIGTERM)
   */
  async killSession(sessionId: number, signal: "SIGINT" | "SIGTERM" = "SIGTERM"): Promise<void> {
    const url = `${this.baseUrl}/v1/sprites/${this.name}/exec/${sessionId}/kill?signal=${signal}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new SpritesError(
        `Failed to kill session ${sessionId}: ${response.status}`,
        response.status,
        text,
      );
    }
  }

  async writeFile(
    path: string,
    content: string,
    options: { mode?: string; mkdir?: boolean } = {},
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}/v1/sprites/${this.name}/fs/write`);
    url.searchParams.set("path", path);

    if (options.mkdir !== false) {
      url.searchParams.set("mkdir", "true");
    }
    if (options.mode) {
      url.searchParams.set("mode", options.mode);
    }

    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: content,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new SpritesError(
        `Failed to write file ${path}: ${response.status}`,
        response.status,
        text,
      );
    }
  }

  /**
   * Get sprite info from the REST API, including the public URL.
   */
  async getSpriteInfo(): Promise<SpriteInfoResponse> {
    const url = `${this.baseUrl}/v1/sprites/${this.name}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new SpritesError(
        `Failed to get sprite info: ${response.status}`,
        response.status,
        text,
      );
    }
    return (await response.json()) as SpriteInfoResponse;
  }

  /**
   * Update the sprite's URL auth settings.
   * "public" makes the URL accessible without authentication.
   * "default" requires the Sprites API token (the default).
   */
  async setUrlAuth(auth: SpriteUrlSettings["auth"]): Promise<void> {
    const url = `${this.baseUrl}/v1/sprites/${this.name}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url_settings: { auth } }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new SpritesError(
        `Failed to update URL settings: ${response.status}`,
        response.status,
        text,
      );
    }
  }
}
