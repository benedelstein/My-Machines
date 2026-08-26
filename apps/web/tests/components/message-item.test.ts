import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { MessageItem } from "@/components/chat/message-item";

afterEach(() => {
  cleanup();
});

function assistantMessage(): UIMessage {
  return {
    id: "message-1",
    role: "assistant",
    parts: [{ type: "text", text: "Partial response" }],
  };
}

function userMessage(): UIMessage {
  return {
    id: "message-2",
    role: "user",
    parts: [{ type: "text", text: "User prompt" }],
  };
}

function codexCommandPart(id: string, command: string): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: "exec",
    toolCallId: id,
    state: "output-available",
    input: {
      type: "commandExecution",
      command,
    },
    output: {
      aggregatedOutput: "",
      exitCode: 0,
    },
  } as UIMessage["parts"][number];
}

function claudeReadPart(id: string, filePath: string): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: "Read",
    toolCallId: id,
    state: "output-available",
    input: {
      file_path: filePath,
    },
    output: "contents",
  } as UIMessage["parts"][number];
}

function codexTodoPart(id: string): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: "update_plan",
    toolCallId: id,
    state: "output-available",
    input: {
      plan: [],
    },
    output: {},
  } as UIMessage["parts"][number];
}

describe("MessageItem", () => {
  it("hides the copy action while an assistant message is streaming", () => {
    render(React.createElement(MessageItem, {
      message: {
        ...assistantMessage(),
        metadata: { startedAt: new Date(Date.now() - 5_000).toISOString() },
      },
      isStreaming: true,
    }));

    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
  });

  it("shows a live work header while an assistant message is streaming", () => {
    render(React.createElement(MessageItem, {
      message: {
        ...assistantMessage(),
        metadata: { startedAt: new Date(Date.now() - 5_000).toISOString() },
      },
      isStreaming: true,
    }));

    expect(screen.getByText(/Working for/)).toBeTruthy();
  });

  it("shows the copy action after an assistant message has settled", () => {
    render(React.createElement(MessageItem, {
      message: assistantMessage(),
      isStreaming: false,
    }));

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("keeps user messages copyable immediately", () => {
    render(React.createElement(MessageItem, {
      message: userMessage(),
      isStreaming: true,
    }));

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("uses active wording for the final command group while streaming", () => {
    render(React.createElement(MessageItem, {
      message: {
        id: "message-3",
        role: "assistant",
        parts: [
          codexCommandPart("command-1", "pnpm build"),
          codexCommandPart("command-2", "pnpm lint"),
        ],
      },
      isStreaming: true,
      providerId: "openai-codex",
    }));

    expect(screen.getByText("Running 2 commands")).toBeTruthy();
    expect(screen.queryByText("Ran 2 commands")).toBeNull();
  });

  it("expands and collapses settled work from its summary", () => {
    render(React.createElement(MessageItem, {
      message: {
        id: "message-6",
        role: "assistant",
        metadata: {
          startedAt: new Date(0).toISOString(),
          endedAt: new Date(35_000).toISOString(),
        },
        parts: [
          codexCommandPart("command-1", "pnpm build"),
          codexCommandPart("command-2", "pnpm lint"),
          { type: "text", text: "Done." },
        ],
      },
      isStreaming: false,
      providerId: "openai-codex",
    }));

    const workHeader = screen.getByRole("button", { name: "Worked for 35s" });

    expect(workHeader.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(workHeader);
    expect(workHeader.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(workHeader);
    expect(workHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("uses past wording for command groups once another tool item follows", () => {
    render(React.createElement(MessageItem, {
      message: {
        id: "message-4",
        role: "assistant",
        parts: [
          codexCommandPart("command-1", "pnpm build"),
          codexCommandPart("command-2", "pnpm lint"),
          codexTodoPart("todo-1"),
        ],
      },
      isStreaming: true,
      providerId: "openai-codex",
    }));

    expect(screen.getByText("Ran 2 commands")).toBeTruthy();
    expect(screen.queryByText("Running 2 commands")).toBeNull();
    expect(screen.getByText("Updated todos")).toBeTruthy();
  });

  it("uses active wording for the final read group while streaming", () => {
    render(React.createElement(MessageItem, {
      message: {
        id: "message-5",
        role: "assistant",
        parts: [
          claudeReadPart("read-1", "/home/sprite/workspace/repo/a.ts"),
          claudeReadPart("read-2", "/home/sprite/workspace/repo/b.ts"),
        ],
      },
      isStreaming: true,
      providerId: "claude-code",
    }));

    expect(screen.getByText("Reading 2 files")).toBeTruthy();
    expect(screen.queryByText("Read 2 files")).toBeNull();
  });
});
