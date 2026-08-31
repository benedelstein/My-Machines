# Turn Workflow (Server Side)

How one user turn moves from the browser to the Sprite VM and back. The current path is webhook-based: the Durable Object dispatches work to a vm-agent process on the sprite, and the vm-agent posts chunks/events back to the Worker.

## Components

- `SessionAgentDO` (`services/api-server/src/runtime/session-agent.do.ts`) - source of truth for session state, SQLite repositories, WebSocket clients, and webhook RPC handlers.
- `SessionChatDispatchService` (`services/api-server/src/modules/session-agent/services/session-chat-dispatch.service.ts`) - validates chat payloads, persists the user message, registers the active turn, and asks the process manager to dispatch it.
- `SessionAgentAttachmentProvider` (`services/api-server/src/runtime/session-agent-attachment-provider.ts`) - resolves message attachment ids to records already bound to the current session before messages are persisted or dispatched.
- `SpriteAgentProcessManager` (`services/api-server/src/modules/session-agent/services/agent-process/sprite-agent-process-manager.service.ts`) - owns vm-agent process reuse, fresh process spawn, credential sync, cancel, and kill.
- `AgentAttachmentService` (`services/api-server/src/modules/session-agent/services/agent-attachment.service.ts`) - downloads session-bound attachment blobs from R2 and converts them to `AgentInputAttachment` data URLs before sending them to the vm-agent.
- `AgentTurnCoordinator` (`services/api-server/src/modules/session-agent/services/agent-turn-coordinator.service.ts`) - owns turn state, WAL replay, chunk accumulation, derived state updates, terminal-chunk finalization, and client broadcasts.
- `SessionSetupOutputService` (`services/api-server/src/modules/session-agent/services/session-setup-output.service.ts`) - persists startup-script stdout/stderr, broadcasts live `setup.output.chunks`, and keeps large output out of synced client state.
- `NotificationPublisher` (`services/api-server/src/modules/notifications/services/notification-publisher.service.ts`) - enqueues non-aborted turn-finished push notifications after summary persistence.
- `WebhookAgentRunner` (`packages/vm-agent/src/webhook-agent-runner.ts`) - runs inside the Sprite VM, drives the shared agent harness, batches stream chunks, and posts webhook payloads.

## Turn Path

```text
Client WS
  -> SessionAgentDO.handleChatMessage
  -> SessionChatDispatchService.prepareChatMessage
  -> SessionAgentAttachmentProvider.getByIdsBoundToSession
  -> RuntimeBoundaryMutex
     -> SessionAgentDO._ensureReady(lease)
     -> MessageRepository.create(user message)
     -> AgentTurnCoordinator.beginTurn(userMessageId)
  -> release RuntimeBoundaryMutex
  -> SessionChatDispatchService.spawnClaimedTurn
  -> SpriteAgentProcessManager.dispatchMessage
     -> AgentAttachmentService.resolveAttachments
     -> try existing vm-agent process via stdin + stdin_ack
     -> otherwise write credentials, agent script, and initial message file
     -> spawn bun agent-webhook.js in a detachable Sprite session
  -> AgentTurnCoordinator.markTurnDispatched(userMessageId, processId)

vm-agent
  -> WebhookAgentRunner queues turn into agent-harness
  -> stream chunks enter ChunkBatcher
  -> POST /internal/session/:sessionId/chunks
  -> POST /internal/session/:sessionId/events for ready/error/sessionId

Webhook routes
  -> verify bearer token from SecretRepository
  -> DO.handleWebhookChunks / DO.handleWebhookEvent
  -> AgentTurnCoordinator
  -> WebSocket broadcast to clients
```

## Server State

Active turn fields live in `server_state`:

```ts
{
  activeUserMessageId: string | null;
  activeTurnDispatchStatus: "claimed" | "dispatched" | null;
  agentProcessId: number | null;
  agentProcessRunId: string | null;
  agentSessionId: string | null;
}
```

Only one user turn may be active per session. A second `chat.message` while `activeUserMessageId` or `pendingUserMessage` is set is rejected with `CHAT_MESSAGE_FAILED`.

## Dispatch

`SessionChatDispatchService` resolves requested attachment ids with `SessionAgentAttachmentProvider.getByIdsBoundToSession(...)` before building the user `UIMessage`. Preparation does not persist messages, update settings, or begin a turn. The stored message keeps attachment parts with `/attachments/{attachmentId}/content` URLs for client display, plus width/height metadata when available. A message with only attachments is valid; empty content and no attachments is rejected.

The final readiness pass and synchronous turn claim share one FIFO `RuntimeBoundaryMutex` ownership interval. Direct chat calls private `_ensureReady(lease)`, checks for an active or pending message, persists the prepared message, and calls `AgentTurnCoordinator.beginTurn()` without another `await`. Pending initial messages use the same boundary. Process I/O starts only after the mutex is released, by which point `activeUserMessageId` and `activeTurnDispatchStatus="claimed"` are durable.

The application mutex is selective. `handleInit` still uses `blockConcurrencyWhile` only for initialization; connection readiness and chat admission use `RuntimeBoundaryMutex`. Inbound chunk and event webhooks never acquire that mutex, so a terminal webhook can clear active state while another readiness caller is queued.

`SpriteAgentProcessManager.dispatchMessage(...)` converts the turn input into an `AgentInputMessage` before either warm-process stdin or fresh spawn. `AgentAttachmentService.resolveAttachments(...)` re-reads the attachment ids bound to the session, downloads each R2 object, and produces `AgentInputAttachment` records with `filename`, `mediaType`, and `dataUrl`. The vm-agent harness turns those records into AI SDK image content parts.

`SpriteAgentProcessManager` prefers warm reuse:

1. Attach to `serverState.agentProcessId`.
2. Write an encoded `{ type: "chat" }` line to stdin.
3. Wait for a typed `stdin_ack` for that `userMessageId`.
4. If attach fails before writing, fall back to a fresh spawn.
5. If writing happened but the ack never arrives, fence the uncertain process before deciding whether a new spawn is safe.

Fresh spawn writes the webhook bundle to `~/.cloude/agent-webhook.js`, stages
the initial message under `~/.cloude/turns/`, and captures the Sprite process id
from the setup session. New sessions receive the connector gateway in
`DO_WEBHOOK_URL` with `DO_WEBHOOK_AUTH=gateway` and no bearer token; the gateway
injects the session credential after verifying the Sprite label. Pre-connector
sessions retain the explicit legacy fallback: the Worker URL plus
`DO_WEBHOOK_AUTH=bearer` and `DO_WEBHOOK_TOKEN`.

If provisioning runs a startup script, `SessionProvisionService` sends stdout/stderr through `SessionSetupOutputService`. The service persists full output in `SetupOutputRepository`, broadcasts batched `setup.output.chunks` messages to connected clients, and leaves only output metadata on the public setup task. `GET /sessions/{sessionId}/setup-output` reads the full accumulated output on demand through `SessionQueryService`.

## Webhooks

Internal routes in `services/api-server/src/modules/session-agent/routes/internal.routes.ts` parse a bearer token from `Authorization` and pass it to the owning DO. For connector sessions, the Sprites gateway injects that bearer from the connector credential after verifying the Sprite label; for legacy sessions, the vm-agent sends the Sprite-held `DO_WEBHOOK_TOKEN`. The DO then compares the received token with `webhook_token` in `SecretRepository`.

- `POST /internal/session/:sessionId/chunks` accepts `{ userMessageId, chunks: [{ sequence, chunk }] }`.
- `POST /internal/session/:sessionId/events` accepts `{ event }` for non-stream agent events such as `ready`, `error`, `sessionId`, and `process_exit`.

The vm-agent writes `ready`, `stdin_ack`, `cancel_ack`, and heartbeat messages to stdout for Sprite attach callers. It posts `ready`, provider `sessionId`, setup/runtime `error`, and final `process_exit` events to the webhook event route. `debug` and heartbeat outputs are local process/logging signals, not webhook events.

`process_exit` carries `processRunId`. `AgentTurnCoordinator.handleProcessExit(...)` ignores the event unless it matches `server_state.agentProcessRunId`, which prevents stale exits from an older vm-agent process from clearing the currently tracked process.

The vm-agent's `WebhookClient` retries network errors, `429`, and `5xx` responses with bounded exponential backoff. Non-retryable failures are logged and dropped; DO reconciliation handles missed tail state where possible.

## Chunk Handling

`AgentTurnCoordinator.handleChunks()` is the ordered ingestion point.

1. Drop stale chunks if `userMessageId` does not match `activeUserMessageId`.
2. Detect sequence gaps using `lastSeenChunkSequence`.
3. Guard each fresh chunk with `validateWireCompatibleChunk(...)` before it enters storage or transport.
4. Insert each chunk into `PendingChunkRepository` with a unique sequence for retry dedupe.
5. Feed fresh chunks into `MessageAccumulator`.
6. Apply derived todos/plan metadata with `applyDerivedStateFromParts`.
7. Broadcast batched `agent.chunks`.
8. On a terminal chunk, persist the finished assistant message, clear the WAL, clear active turn state, invoke the DO `onTurnFinished` callback, and broadcast `agent.finish`.
9. `SessionAgentDO.onTurnFinished` persists summary metadata. For non-aborted turns, it then enqueues a turn-finished notification through `NotificationPublisher` and queues server-side pull request creation if a pushed branch exists without a stored PR.

The DO broadcasts chunk batches rather than individual chunks. The client protocol still receives WebSocket messages from the DO, not direct sprite traffic.

## Cancel

`SessionAgentDO.cancelActiveTurnAndClearState()` delegates to `SpriteAgentProcessManager.cancelActiveTurn()`.

- Graceful path: attach to the active process, write `{ type: "cancel", userMessageId }`, and wait for `cancel_ack`. The process can be reused if it acknowledges.
- Fenced path: if graceful cancel fails, terminate the Sprite exec session with `SIGTERM` and clear the process id.
- DO cleanup: if the process was not preserved, `AgentTurnCoordinator.markTurnCanceled()` persists any partial assistant message as aborted and clears active turn state.

## Recovery

The WAL invariant is: pending chunks imply an active or recently active turn. On DO startup, `AgentTurnCoordinator.ensureRehydratedState()`:

1. Replays `pending_message_chunks` into `MessageAccumulator`.
2. Re-applies derived todos/plan state.
3. Restores `lastSeenChunkSequence`.
4. If an active process id exists, attempts to attach to that Sprite process.
5. If the process is gone, commits the partial assistant message as aborted and clears active turn state.

Readiness separately reconciles the claim-to-dispatch handoff. A durable
`activeTurnDispatchStatus="claimed"` with no matching in-memory dispatch means
the Worker stopped before dispatch was confirmed. Readiness aborts that claim
and clears active/process state even if a reusable process id was already
present. Once dispatch returns or the first chunk confirms delivery, the status
becomes `dispatched`. Every terminal, abort, and spawn-failure path queues a new
readiness pass after clearing active state.

Duplicate webhook batches are deduped by the WAL sequence constraint. Missing chunks abort the active turn, surface `CHAT_MESSAGE_FAILED`, and terminate the active process.

## Related Files

- Webhook routes: [internal.routes.ts](../services/api-server/src/modules/session-agent/routes/internal.routes.ts)
- DO entrypoint: [session-agent.do.ts](../services/api-server/src/runtime/session-agent.do.ts)
- Dispatch service: [session-chat-dispatch.service.ts](../services/api-server/src/modules/session-agent/services/session-chat-dispatch.service.ts)
- Turn coordinator: [agent-turn-coordinator.service.ts](../services/api-server/src/modules/session-agent/services/agent-turn-coordinator.service.ts)
- Setup output service: [session-setup-output.service.ts](../services/api-server/src/modules/session-agent/services/session-setup-output.service.ts)
- Setup output repository: [setup-output.repository.ts](../services/api-server/src/modules/session-agent/repositories/setup-output.repository.ts)
- Session attachment provider: [session-agent-attachment-provider.ts](../services/api-server/src/runtime/session-agent-attachment-provider.ts)
- Agent attachment service: [agent-attachment.service.ts](../services/api-server/src/modules/session-agent/services/agent-attachment.service.ts)
- Notification publisher: [notification-publisher.service.ts](../services/api-server/src/modules/notifications/services/notification-publisher.service.ts)
- Notification queue consumer: [notification-queue-consumer.service.ts](../services/api-server/src/modules/notifications/services/notification-queue-consumer.service.ts)
- Automatic PR queue: [session-auto-pull-request.service.ts](../services/api-server/src/runtime/session-auto-pull-request.service.ts)
- Process manager: [sprite-agent-process-manager.service.ts](../services/api-server/src/modules/session-agent/services/agent-process/sprite-agent-process-manager.service.ts)
- VM webhook runner: [webhook-agent-runner.ts](../packages/vm-agent/src/webhook-agent-runner.ts)
- WAL table: [pending-chunk.repository.ts](../services/api-server/src/modules/session-agent/repositories/pending-chunk.repository.ts)
- Server state: [server-state.repository.ts](../services/api-server/src/modules/session-agent/repositories/server-state.repository.ts)
