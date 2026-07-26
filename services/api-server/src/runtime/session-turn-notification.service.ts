import type { UIMessage } from "ai";
import type { NotificationPublisher } from "@/modules/notifications/services/notification-publisher.service";
import { extractFinalUiMessageText } from "@/shared/utils/uimessage-utils";

interface SessionTitleRepository {
  getByIdForUser(
    sessionId: string,
    userId: string,
  ): Promise<{ title: string | null; repoFullName: string } | null>;
}

export interface SessionTurnNotificationServiceDeps {
  notificationPublisher: NotificationPublisher;
  sessionsRepository: SessionTitleRepository;
}

export class SessionTurnNotificationService {
  private readonly notificationPublisher: NotificationPublisher;
  private readonly sessionsRepository: SessionTitleRepository;

  constructor(deps: SessionTurnNotificationServiceDeps) {
    this.notificationPublisher = deps.notificationPublisher;
    this.sessionsRepository = deps.sessionsRepository;
  }

  async publishTurnFinished(params: {
    toUserId: string;
    sessionId: string;
    messageId: string;
    repoFullName: string;
    message: UIMessage;
  }): Promise<void> {
    const session = await this.sessionsRepository.getByIdForUser(
      params.sessionId,
      params.toUserId,
    );
    const sessionTitle = session?.title?.trim() || session?.repoFullName || params.repoFullName;

    await this.notificationPublisher.publishTurnFinished({
      toUserId: params.toUserId,
      sessionId: params.sessionId,
      messageId: params.messageId,
      sessionTitle,
      repoFullName: params.repoFullName,
      messagePreview: extractFinalUiMessageText(params.message),
    });
  }
}
