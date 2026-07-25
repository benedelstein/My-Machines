export class SpritesError extends Error {
    constructor(
        message: string,
        public statusCode: number,
        public responseBody?: string
    ) {
        super(message);
        this.name = "SpritesError";
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }
}


export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface NewExecSessionOptions {
    /** The working directory for the process */
    cwd?: string;
    /** Environment variables to set for the process. If omitted, no environment variables are set. */
    env?: Record<string, string>;
    /** Whether to use TTY mode. If omitted, false */
    tty?: boolean;
    /** Whether to attach websocket-backed stdin to the process. If omitted, true. */
    stdin?: boolean;
    /** Number of columns in the TTY. If omitted, the sprite will use the default. */
    cols?: number;
    /** Number of rows in the TTY. If omitted, the sprite will use the default. */
    rows?: number;
    /** Unsure */
    detachable?: boolean;
    /**
     * The amount of time to wait for stdout /stderr to appear before timing out the websocket connection.
     * If omitted, no idle timeout is applied.
     * Note - a long running process may emit stdout /stderr slowly, so only use this for processes that are 
     * expected to emit output regularly.
     */
    idleTimeoutMs?: number;
    /**
     * Duration the process continues running on the sprite after the
     * websocket client disconnects. Accepts Go-style duration strings
     * (e.g. "60s", "5m") or "0" to keep the process alive indefinitely.
     * Sprite defaults: 0 for TTY, 10s for non-TTY.
     * See https://sprites.dev/api/sprites/exec
     */
    maxRunAfterDisconnect?: string;
}

export interface AttachSessionOptions {
    cwd?: string;
    env?: Record<string, string>;
    detachable?: boolean;
    idleTimeoutMs?: number;
}

// Server message types from Sprites exec WebSocket

import { z } from "zod";

/**
 * This message is sent by the sprite - not controlled by us
 */
export const SessionInfoMessageSchema = z.object({
    type: z.literal("session_info"),
    session_id: z.coerce.number(),
    command: z.string(),
    created: z.number(),
    cols: z.number().optional(),
    rows: z.number().optional(),
    is_owner: z.boolean(),
    tty: z.boolean(),
});

/**
 * This message is sent by the sprite - not controlled by us
 */
export const ExitMessageSchema = z.object({
    type: z.literal("exit"),
    exit_code: z.number(),
});

/**
 * This message is sent by the sprite - not controlled by us
 */
export const PortNotificationMessageSchema = z.object({
    type: z.enum(["port_opened", "port_closed"]),
    port: z.number(),
    address: z.string(),
    pid: z.number(),
});

export const DebugMessageSchema = z.object({
    type: z.literal("debug"),
    msg: z.string(),
    pid: z.number().optional(),
    t_ms: z.number().optional(),
});

export const SpriteServerMessageSchema = z.discriminatedUnion("type", [
    SessionInfoMessageSchema,
    ExitMessageSchema,
    PortNotificationMessageSchema,
    DebugMessageSchema,
]);

export type SessionInfoMessage = z.infer<typeof SessionInfoMessageSchema>;
export type ExitMessage = z.infer<typeof ExitMessageSchema>;
export type PortNotificationMessage = z.infer<typeof PortNotificationMessageSchema>;
export type SpriteServerMessage = z.infer<typeof SpriteServerMessageSchema>;
