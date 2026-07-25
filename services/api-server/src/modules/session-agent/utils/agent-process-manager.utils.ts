import { type AgentOutput, decodeAgentOutput } from "@repo/shared";
import type {
  SpriteServerMessage,
  SpriteWebsocketSession,
} from "@repo/sprites-client";

export type SessionSignalDecision<T> =
  | { type: "continue" }
  | { type: "resolve"; value: T }
  | { type: "reject"; error: Error };

export function continueWaiting<T>(): SessionSignalDecision<T> {
  return { type: "continue" };
}

export function resolveWaiting<T>(value: T): SessionSignalDecision<T> {
  return { type: "resolve", value };
}

export function rejectWaiting<T>(error: Error): SessionSignalDecision<T> {
  return { type: "reject", error };
}

export function consumeLines(
  buffer: string,
  chunk: string,
): { lines: string[]; remainder: string } {
  const parts = `${buffer}${chunk}`.split("\n");
  return {
    lines: parts.slice(0, -1),
    remainder: parts.at(-1) ?? "",
  };
}

export function lineMatchesAgentOutput(
  line: string,
  predicate: (output: AgentOutput) => boolean,
): boolean {
  const trimmedLine = line.replace(/\r$/, "");
  if (!trimmedLine) {
    return false;
  }

  try {
    return predicate(decodeAgentOutput(trimmedLine));
  } catch {
    return false;
  }
}

export async function waitForSessionSignals<T>(
  session: SpriteWebsocketSession,
  args: {
    timeoutMs: number;
    startSession?: boolean;
    onStdoutLine?: (line: string) => SessionSignalDecision<T>;
    onServerMessage?: (message: SpriteServerMessage) => SessionSignalDecision<T>;
    onError: (error: Error) => SessionSignalDecision<T>;
    onExit: (code: number) => SessionSignalDecision<T>;
    onTimeout: () => SessionSignalDecision<T>;
  },
): Promise<T> {
  let stdoutBuffer = "";
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const disposers: Array<() => void> = [];

  const cleanup = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    for (const dispose of disposers) {
      dispose();
    }
  };

  const waitPromise = new Promise<T>((resolve, reject) => {
    const settle = (decision: SessionSignalDecision<T>) => {
      if (settled || decision.type === "continue") {
        return;
      }
      settled = true;
      cleanup();
      if (decision.type === "resolve") {
        resolve(decision.value);
        return;
      }
      reject(decision.error);
    };

    const handleDecision = (getDecision: () => SessionSignalDecision<T>) => {
      try {
        settle(getDecision());
      } catch (error) {
        const normalizedError = error instanceof Error
          ? error
          : new Error(String(error));
        settle(rejectWaiting(normalizedError));
      }
    };

    const onStdoutLine = args.onStdoutLine;
    if (onStdoutLine) {
      disposers.push(
        session.onStdout((chunk) => {
          const parsed = consumeLines(stdoutBuffer, chunk);
          stdoutBuffer = parsed.remainder;
          for (const line of parsed.lines) {
            handleDecision(() => onStdoutLine(line));
          }
        }),
      );
    }
    const onServerMessage = args.onServerMessage;
    if (onServerMessage) {
      disposers.push(
        session.onServerMessage((message) => {
          handleDecision(() => onServerMessage(message));
        }),
      );
    }
    disposers.push(
      session.onError((error) => {
        handleDecision(() => args.onError(error));
      }),
    );
    disposers.push(
      session.onExit((code) => {
        handleDecision(() => args.onExit(code));
      }),
    );

    timeout = setTimeout(() => {
      handleDecision(args.onTimeout);
    }, args.timeoutMs);
  });

  try {
    if (args.startSession) {
      await session.start();
    }
    return await waitPromise;
  } finally {
    cleanup();
  }
}

export async function hashScript(script: string): Promise<string | null> {
  return await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(script))
    .then((buf) =>
      Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
}
