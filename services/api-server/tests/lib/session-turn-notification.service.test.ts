import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { NotificationPublisher } from "../../src/modules/notifications/services/notification-publisher.service";
import { SessionTurnNotificationService } from "../../src/runtime/session-turn-notification.service";

function createMessage(text: string): UIMessage {
  return {
    id: "message-1",
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

describe("SessionTurnNotificationService", () => {
  it("uses the stored session title as the turn finished notification title", async () => {
    const publishTurnFinished = vi.fn<NotificationPublisher["publishTurnFinished"]>()
      .mockResolvedValue(undefined);
    const service = new SessionTurnNotificationService({
      notificationPublisher: { publishTurnFinished } as unknown as NotificationPublisher,
      sessionsRepository: {
        getByIdForUser: vi.fn().mockResolvedValue({
          title: "Fix notification copy",
          repoFullName: "owner/repo",
        }),
      },
    });

    await service.publishTurnFinished({
      toUserId: "user-1",
      sessionId: "session-1",
      messageId: "message-1",
      repoFullName: "owner/repo",
      message: createMessage("Final answer"),
    });

    expect(publishTurnFinished).toHaveBeenCalledWith({
      toUserId: "user-1",
      sessionId: "session-1",
      messageId: "message-1",
      sessionTitle: "Fix notification copy",
      repoFullName: "owner/repo",
      messagePreview: "Final answer",
    });
  });

  it("uses the final text part of the message as the preview", async () => {
    const publishTurnFinished = vi.fn<NotificationPublisher["publishTurnFinished"]>()
      .mockResolvedValue(undefined);
    const service = new SessionTurnNotificationService({
      notificationPublisher: { publishTurnFinished } as unknown as NotificationPublisher,
      sessionsRepository: {
        getByIdForUser: vi.fn().mockResolvedValue({
          title: "Fix notification copy",
          repoFullName: "owner/repo",
        }),
      },
    });

    await service.publishTurnFinished({
      toUserId: "user-1",
      sessionId: "session-1",
      messageId: "message-1",
      repoFullName: "owner/repo",
      message: {
        id: "message-1",
        role: "assistant",
        parts: [
          { type: "text", text: "Let me look at the code." },
          { type: "step-start" },
          { type: "text", text: "Done. The bug was in the parser." },
          { type: "text", text: "   " },
        ],
      },
    });

    expect(publishTurnFinished).toHaveBeenCalledWith(expect.objectContaining({
      messagePreview: "Done. The bug was in the parser.",
    }));
  });

  it("falls back to the current repo name when the session title is missing", async () => {
    const publishTurnFinished = vi.fn<NotificationPublisher["publishTurnFinished"]>()
      .mockResolvedValue(undefined);
    const service = new SessionTurnNotificationService({
      notificationPublisher: { publishTurnFinished } as unknown as NotificationPublisher,
      sessionsRepository: {
        getByIdForUser: vi.fn().mockResolvedValue({
          title: " ",
          repoFullName: "owner/repo-from-db",
        }),
      },
    });

    await service.publishTurnFinished({
      toUserId: "user-1",
      sessionId: "session-1",
      messageId: "message-1",
      repoFullName: "owner/current-repo",
      message: createMessage("Final answer"),
    });

    expect(publishTurnFinished).toHaveBeenCalledWith(expect.objectContaining({
      sessionTitle: "owner/repo-from-db",
    }));
  });
});
