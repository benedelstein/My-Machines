"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import type {
  ListReposResponse,
  ProviderId,
  SessionSetupOutputResponse,
  SessionSetupRun,
  SessionSetupTask,
  StartupScriptSetupTask,
} from "@repo/shared";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Loader2,
  MessageCircle,
  XCircle,
} from "lucide-react";
import clsx from "clsx";
import { getSessionSetupOutput, listRepos } from "@/lib/client-api";
import type { SetupScriptOutputState } from "@/hooks/use-setup-script-output";
import { CACHE_KEY_REPOS, readCache } from "@/lib/swr-cache";
import { useGitHubReauth } from "@/hooks/use-github-reauth";
import { MessageItem } from "./message-item";
import { WorkingCloudRow } from "./working-cloud-indicator";
import { Skeleton } from "@/components/ui/skeleton";
import { GithubIcon } from "@/components/github-icon";

const MESSAGE_HISTORY_SKELETONS = [
  { role: "assistant", lines: ["w-[82%]", "w-[76%]", "w-[68%]", "w-[74%]"] },
  { role: "user", lines: ["w-56", "w-40"] },
  { role: "assistant", lines: ["w-[88%]", "w-[80%]", "w-[84%]", "w-[62%]", "w-[72%]"] },
  { role: "user", lines: ["w-64"] },
] as const;

interface MessageListProps {
  messages: UIMessage[];
  streamingMessage: UIMessage | null;
  isHistoryLoading?: boolean;
  sessionErrorMessage?: string | null;
  sessionErrorCode?: string | null;
  sessionId?: string | null;
  sessionSetupRun?: SessionSetupRun | null;
  setupScriptOutput?: SetupScriptOutputState | null;
  onHydrateSetupOutput?: (snapshot: SessionSetupOutputResponse) => void;
  isResponding?: boolean;
  pendingUserMessage?: UIMessage | null;
  userAvatarUrl?: string | null;
  providerId?: ProviderId | null;
  rightInset?: string;
  isRightInsetResizing?: boolean;
  onHasNewMessages?: (hasNew: boolean) => void;
  scrollToBottomRef?: React.RefObject<(() => void) | null>;
}

export function MessageList({
  messages,
  streamingMessage,
  isHistoryLoading = false,
  sessionErrorMessage = null,
  sessionErrorCode = null,
  sessionId = null,
  sessionSetupRun = null,
  setupScriptOutput = null,
  onHydrateSetupOutput,
  isResponding,
  pendingUserMessage,
  userAvatarUrl,
  providerId,
  rightInset = "0rem",
  isRightInsetResizing = false,
  onHasNewMessages,
  scrollToBottomRef,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabled = useRef(true);
  const hasNewMessages = useRef(false);
  const pendingAutoScrollBehavior = useRef<ScrollBehavior>("auto");
  // Keep a ref to the callback so event-handler closures always see the latest
  const onHasNewMessagesRef = useRef(onHasNewMessages);
  onHasNewMessagesRef.current = onHasNewMessages;

  const notifyHasNewMessages = useCallback((hasNew: boolean) => {
    if (hasNewMessages.current === hasNew) {
      return;
    }
    hasNewMessages.current = hasNew;
    onHasNewMessagesRef.current?.(hasNew);
  }, []);

  const isNearBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) { return true; }
    // pb-64 (256px) on the scroll container sits behind the floating input,
    // so the user appears at the bottom well before scrollTop reaches the end.
    const threshold = 200;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior, persistBehavior = true) => {
    autoScrollEnabled.current = true;
    if (persistBehavior) {
      pendingAutoScrollBehavior.current = behavior;
    }
    notifyHasNewMessages(false);
    bottomRef.current?.scrollIntoView({ behavior });
  }, [notifyHasNewMessages]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) { return; }

    const handleScroll = () => {
      const nearBottom = isNearBottom();
      autoScrollEnabled.current = nearBottom;

      if (nearBottom) {
        notifyHasNewMessages(false);
      }
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [isNearBottom, notifyHasNewMessages]);

  // Expose a scroll-to-bottom function to the parent
  useEffect(() => {
    if (scrollToBottomRef) {
      scrollToBottomRef.current = () => {
        scrollToBottom("smooth");
      };
    }
    return () => {
      if (scrollToBottomRef) {
        scrollToBottomRef.current = null;
      }
    };
  }, [scrollToBottom, scrollToBottomRef]);

  // Include streaming part growth so active assistant responses stay pinned while autoscroll is enabled.
  const streamingContentSignal = streamingMessage
    ? `${streamingMessage.id}:${JSON.stringify(streamingMessage.parts ?? []).length}`
    : "idle";
  const contentSignal = [
    messages.length,
    streamingContentSignal,
    pendingUserMessage?.id ?? "none",
    isResponding ? "responding" : "idle",
    sessionSetupRun ? `${sessionSetupRun.id}:${sessionSetupRun.status}` : "no-setup",
  ].join(":");

  // Auto-scroll to bottom when new content arrives, only if enabled
  useLayoutEffect(() => {
    if (autoScrollEnabled.current) {
      const behavior = pendingAutoScrollBehavior.current;
      pendingAutoScrollBehavior.current = "auto";
      scrollToBottom(behavior, false);
    } else {
      notifyHasNewMessages(true);
    }
  }, [contentSignal, notifyHasNewMessages, scrollToBottom]);

  const allMessages = streamingMessage
    ? [...messages, streamingMessage]
    : messages;
  const hasPendingUserMessage = !!pendingUserMessage;
  const shouldRenderPendingUserMessage = hasPendingUserMessage
    && !allMessages.some((message) => message.id === pendingUserMessage.id);
  const shouldRenderSetupRun = sessionSetupRun !== null;
  const firstAssistantMessageId = allMessages.find((message) => message.role === "assistant")?.id ?? null;
  const latestUserMessageIndex = findLastMessageIndex(allMessages, "user");
  const latestAssistantMessageIndex = findLastMessageIndex(allMessages, "assistant");
  const latestAssistantMessageId = latestAssistantMessageIndex === -1
    ? null
    : allMessages[latestAssistantMessageIndex]?.id ?? null;
  const activeAssistantMessageId = streamingMessage?.id
    ?? (isResponding && latestAssistantMessageIndex > latestUserMessageIndex ? latestAssistantMessageId : null);
  const isSetupRunning = sessionSetupRun !== null && sessionSetupRun.status === "running";
  const isPersistentWorkingCloudActive = isResponding === true || isSetupRunning;

  const showError = sessionErrorMessage !== null
    && allMessages.length === 0
    && !hasPendingUserMessage;
  const showLoading = !showError
    && isHistoryLoading
    && allMessages.length === 0
    && !hasPendingUserMessage
    && !shouldRenderSetupRun;
  const showEmpty = !showError
    && !showLoading
    && allMessages.length === 0
    && !hasPendingUserMessage
    && !shouldRenderSetupRun
    && !isResponding;

  return (
    <div
      ref={containerRef}
      className={`h-full overflow-y-auto pt-20 pb-64 ${isRightInsetResizing ? "" : "transition-[padding] duration-200 ease-linear"}`}
      style={{ paddingRight: rightInset }}
    >
      {showError && (
        <div className="h-full flex items-center justify-center p-6">
          <BlockedSessionState
            message={sessionErrorMessage}
            errorCode={sessionErrorCode}
          />
        </div>
      )}
      {showLoading && (
        <div role="status" aria-label="Loading messages">
          <MessageHistorySkeleton />
        </div>
      )}
      {showEmpty && (
        <div className="h-full flex items-center justify-center p-4">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-accent-subtle flex items-center justify-center">
              <MessageCircle className="w-8 h-8 text-accent" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Start a conversation</h3>
            <p className="text-foreground-secondary text-sm">
              Send a message to begin working with the agent on your repository.
            </p>
          </div>
        </div>
      )}
      {!showError && !showLoading && !showEmpty && (
        <div className="max-w-4xl mx-auto px-8 space-y-2">
          {allMessages.map((message) => (
            <div key={message.id} className="contents">
              {shouldRenderSetupRun && sessionSetupRun && message.id === firstAssistantMessageId && (
                <SessionSetupRunIndicator
                  setupRun={sessionSetupRun}
                  sessionId={sessionId}
                  liveOutput={setupScriptOutput}
                  onHydrateOutput={onHydrateSetupOutput}
                />
              )}
              <MessageItem
                message={message}
                isStreaming={activeAssistantMessageId === message.id}
                userAvatarUrl={userAvatarUrl}
                providerId={providerId}
                className={
                  shouldRenderSetupRun && sessionSetupRun && message.id === firstAssistantMessageId
                    ? "mt-1"
                    : undefined
                }
              />
            </div>
          ))}
          {shouldRenderPendingUserMessage && pendingUserMessage && (
            <MessageItem
              message={pendingUserMessage}
              userAvatarUrl={userAvatarUrl}
              providerId={providerId}
            />
          )}
          {shouldRenderSetupRun && sessionSetupRun && firstAssistantMessageId === null && (
            <SessionSetupRunIndicator
              setupRun={sessionSetupRun}
              sessionId={sessionId}
              liveOutput={setupScriptOutput}
              onHydrateOutput={onHydrateSetupOutput}
            />
          )}
          <PersistentWorkingCloud active={isPersistentWorkingCloudActive} />
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

function MessageHistorySkeleton() {
  return (
    <div className="max-w-4xl mx-auto px-8 space-y-8">
      {MESSAGE_HISTORY_SKELETONS.map((message, index) => (
        <div
          key={index}
          className={message.role === "user" ? "flex justify-end" : undefined}
        >
          <div
            className={message.role === "user"
              ? "w-[55%] max-w-md space-y-2"
              : "w-[85%] max-w-3xl space-y-2"}
          >
            {message.lines.map((width, lineIndex) => (
              <Skeleton
                key={lineIndex}
                className={`h-2.5 rounded-full bg-muted ${width} ${message.role === "user" ? "ml-auto" : ""}`}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PersistentWorkingCloud({ active }: { active: boolean }) {
  return (
    <div className="w-fit py-1">
      <WorkingCloudRow active={active} />
    </div>
  );
}

function findLastMessageIndex(messages: UIMessage[], role: UIMessage["role"]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === role) {
      return index;
    }
  }
  return -1;
}

function SessionSetupRunIndicator({
  setupRun,
  sessionId,
  liveOutput,
  onHydrateOutput,
}: {
  setupRun: SessionSetupRun;
  sessionId: string | null;
  liveOutput: SetupScriptOutputState | null;
  onHydrateOutput?: (snapshot: SessionSetupOutputResponse) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(setupRun.status !== "completed");

  useEffect(() => {
    setIsExpanded(setupRun.status !== "completed");
  }, [setupRun.id, setupRun.status]);

  const title = getSetupRunTitle(setupRun);

  return (
    <div
      role="status"
      aria-label={title}
      className="w-fit py-1 text-[13px] text-foreground-secondary"
    >
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        className="group flex w-fit items-center gap-2 text-left text-[13px] text-foreground-secondary transition-colors hover:text-foreground"
        aria-expanded={isExpanded}
      >
        <span>{title}</span>
        <ChevronRight
          className={clsx(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            isExpanded ? "rotate-90" : "hidden group-hover:block",
          )}
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1 space-y-0.5">
            {setupRun.tasks.map((task) => (
              <SessionSetupTaskRow
                key={task.id}
                task={task}
                sessionId={sessionId}
                liveOutput={liveOutput}
                onHydrateOutput={onHydrateOutput}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionSetupTaskRow({
  task,
  sessionId,
  liveOutput,
  onHydrateOutput,
}: {
  task: SessionSetupTask;
  sessionId: string | null;
  liveOutput: SetupScriptOutputState | null;
  onHydrateOutput?: (snapshot: SessionSetupOutputResponse) => void;
}) {
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  const [fetchedOutput, setFetchedOutput] = useState<SessionSetupOutputResponse | null>(null);
  const [isOutputLoading, setIsOutputLoading] = useState(false);
  const setupScriptTask = getSetupScriptTask(task);
  const isScriptRunning = setupScriptTask?.status === "running";

  const taskOutput = setupScriptTask?.output ?? null;
  // Inline output only exists on runs from before output streaming.
  const hasLegacyOutput = Boolean(taskOutput && (taskOutput.stdout || taskOutput.stderr));
  const hasStoredOutput =
    (taskOutput?.stdoutLength ?? 0) > 0 || (taskOutput?.stderrLength ?? 0) > 0;
  const hasLiveOutput =
    liveOutput !== null && (liveOutput.stdout.length > 0 || liveOutput.stderr.length > 0);
  // Terminal tasks repaired after a server restart can have stored output but
  // no metadata; offer the expand-and-fetch path for those too.
  const mayHaveUnknownOutput = taskOutput === null
    && (setupScriptTask?.status === "completed" || setupScriptTask?.status === "failed");
  const hasOutput =
    setupScriptTask !== null
    && (isScriptRunning || hasLiveOutput || hasStoredOutput || hasLegacyOutput || mayHaveUnknownOutput);

  // Auto-open the output while the script runs and hydrate any output
  // produced before this client connected; live chunks fill in the rest.
  useEffect(() => {
    if (!isScriptRunning) { return; }
    setIsOutputOpen(true);
    if (!sessionId || !onHydrateOutput) { return; }
    let cancelled = false;
    getSessionSetupOutput(sessionId)
      .then((snapshot) => {
        if (!cancelled && snapshot) {
          onHydrateOutput(snapshot);
        }
      })
      .catch((error) => console.warn("Failed to hydrate setup output", error));
    return () => {
      cancelled = true;
    };
  }, [isScriptRunning, sessionId, onHydrateOutput]);

  const toggleOutput = () => {
    const nextOpen = !isOutputOpen;
    setIsOutputOpen(nextOpen);
    const needsFetch = nextOpen
      && !isScriptRunning
      && !hasLiveOutput
      && !hasLegacyOutput
      && !fetchedOutput
      && (hasStoredOutput || mayHaveUnknownOutput)
      && sessionId !== null;
    if (needsFetch) {
      setIsOutputLoading(true);
      getSessionSetupOutput(sessionId)
        .then((snapshot) => setFetchedOutput(snapshot))
        .catch((error) => console.warn("Failed to fetch setup output", error))
        .finally(() => setIsOutputLoading(false));
    }
  };

  const displayOutput = hasLiveOutput && liveOutput
    ? { stdout: liveOutput.stdout, stderr: liveOutput.stderr }
    : fetchedOutput
      ? { stdout: fetchedOutput.stdout, stderr: fetchedOutput.stderr }
      : hasLegacyOutput && taskOutput
        ? { stdout: taskOutput.stdout ?? "", stderr: taskOutput.stderr ?? "" }
        : null;

  const taskLabel = getSetupTaskLabel(task);

  return (
    <div className="py-1">
      <div className="flex min-w-0 items-start gap-2">
        <SetupTaskStatusIcon task={task} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {hasOutput ? (
              <button
                type="button"
                onClick={toggleOutput}
                className="inline-flex min-w-0 items-center gap-1 text-[13px] text-foreground-secondary transition-colors hover:text-foreground"
                aria-expanded={isOutputOpen}
              >
                <span className="min-w-0 truncate">{taskLabel}</span>
                <ChevronRight
                  className={clsx(
                    "h-3.5 w-3.5 shrink-0 transition-transform",
                    isOutputOpen && "rotate-90",
                  )}
                />
              </button>
            ) : (
              <span className="min-w-0 truncate text-[13px] text-foreground-secondary">
                {taskLabel}
              </span>
            )}
          </div>
          {task.error && (
            <p className="mt-1 text-xs leading-5 text-danger">{task.error}</p>
          )}
          {setupScriptTask?.status === "skipped" && setupScriptTask.skipReason && (
            <SetupScriptSkippedReason skipReason={setupScriptTask.skipReason} />
          )}
          {hasOutput && (
            <div
              className={`grid transition-[grid-template-rows] duration-200 ease-out ${isOutputOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
            >
              <div className="min-h-0 overflow-hidden">
                <SessionSetupOutput
                  output={displayOutput}
                  exitCode={taskOutput?.exitCode ?? null}
                  isLoading={isOutputLoading}
                  isRunning={isScriptRunning}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SetupScriptSkippedReason({
  skipReason,
}: {
  skipReason: NonNullable<StartupScriptSetupTask["skipReason"]>;
}) {
  const linkClassName = "font-medium text-foreground underline underline-offset-2 transition-colors hover:text-accent";

  if (skipReason.kind === "no_environment") {
    return (
      <p className="mt-1 max-w-lg text-xs leading-5 text-foreground-tertiary">
        No environment is connected to this session.{" "}
        <Link
          href={`/settings/environments/create?repoId=${skipReason.repoId}`}
          className={linkClassName}
        >
          Create an environment
        </Link>{" "}
        to add a setup script.
      </p>
    );
  }

  return (
    <p className="mt-1 max-w-lg text-xs leading-5 text-foreground-tertiary">
      This environment does not have a setup script.{" "}
      <Link
        href={`/settings/environments/${skipReason.environmentId}`}
        className={linkClassName}
      >
        Edit {skipReason.environmentName ?? "the environment"}
      </Link>{" "}
      to add one.
    </p>
  );
}

function getSetupScriptTask(task: SessionSetupTask): StartupScriptSetupTask | null {
  return task.id === "setup_script" ? task : null;
}

function SetupTaskStatusIcon({ task }: { task: SessionSetupTask }) {
  switch (task.status) {
    case "pending":
      return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-foreground-tertiary/60" strokeWidth={1.75} />;
    case "running":
      return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />;
    case "completed":
      return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />;
    case "failed":
      return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />;
    case "skipped":
      return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-foreground-tertiary/60" strokeWidth={1.75} />;
  }
}

function SessionSetupOutput({
  output,
  exitCode,
  isLoading,
  isRunning,
}: {
  output: { stdout: string; stderr: string } | null;
  exitCode: number | null;
  isLoading: boolean;
  isRunning: boolean;
}) {
  return (
    <div className="my-1 overflow-hidden rounded-md border border-border bg-background text-xs">
      {isLoading && (
        <div className="space-y-1.5 px-3 py-2" role="status" aria-label="Loading setup output">
          <Skeleton className="h-2.5 w-3/4 rounded-full bg-muted" />
          <Skeleton className="h-2.5 w-1/2 rounded-full bg-muted" />
          <Skeleton className="h-2.5 w-2/3 rounded-full bg-muted" />
        </div>
      )}
      {!isLoading && !output && (
        <div className="px-3 py-2 font-mono text-foreground-tertiary">
          {isRunning ? "Waiting for output..." : "No output"}
        </div>
      )}
      {output?.stdout && (
        <SetupOutputBlock label="stdout" value={output.stdout} followTail={isRunning} />
      )}
      {output?.stderr && (
        <SetupOutputBlock label="stderr" value={output.stderr} followTail={isRunning} />
      )}
      {exitCode !== null && (
        <div className="border-t border-border bg-muted/30 px-3 py-1.5 font-mono text-foreground-secondary">
          exit {exitCode}
        </div>
      )}
    </div>
  );
}

function SetupOutputBlock({
  label,
  value,
  followTail = false,
}: {
  label: string;
  value: string;
  followTail?: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);

  // Keep the live tail pinned to the newest output while the script runs.
  useEffect(() => {
    if (!followTail) { return; }
    const pre = preRef.current;
    if (pre) {
      pre.scrollTop = pre.scrollHeight;
    }
  }, [followTail, value]);

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="border-b border-border bg-muted/30 px-3 py-1.5 font-mono text-foreground-secondary">
        {label.toUpperCase()}
      </div>
      <pre
        ref={preRef}
        className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word px-3 py-2 font-mono leading-relaxed text-foreground-secondary"
      >
        {value}
      </pre>
    </div>
  );
}

function getSetupRunTitle(setupRun: SessionSetupRun): string {
  if (setupRun.status === "running") {
    return "Initializing session";
  }
  if (setupRun.status === "failed") {
    return "Initialization failed";
  }
  return "Initialized session";
}

function getSetupTaskLabel(task: SessionSetupTask): string {
  switch (task.id) {
    case "cloud_container": {
      switch (task.status) {
        case "pending":
          return "Set up cloud computer";
        case "running":
          return "Setting up cloud computer";
        case "completed":
          return "Set up cloud computer";
        case "failed":
          return "Cloud computer setup failed";
        case "skipped":
          return "Skipped cloud computer setup";
      }
      return "Set up cloud computer";
    }
    case "session_connector": {
      switch (task.status) {
        case "pending":
          return "Secure session credentials";
        case "running":
          return "Securing session credentials";
        case "completed":
          return "Secured session credentials";
        case "failed":
          return "Session credential setup failed";
        case "skipped":
          return "Skipped session credential setup";
      }
      return "Secure session credentials";
    }
    case "repository": {
      switch (task.status) {
        case "pending":
          return "Clone repository";
        case "running":
          return "Cloning repository";
        case "completed":
          return "Cloned repository";
        case "failed":
          return "Repository clone failed";
        case "skipped":
          return "Skipped repository clone";
      }
      return "Clone repository";
    }
    case "setup_script": {
      switch (task.status) {
        case "pending":
          return "Run setup script";
        case "running":
          return "Running setup script";
        case "completed":
          return "Completed setup script";
        case "failed":
          return "Setup script failed";
        case "skipped":
          return "Skipped setup script";
      }
      return "Run setup script";
    }
    case "network_policy": {
      switch (task.status) {
        case "pending":
          return "Apply network policy";
        case "running":
          return "Applying network policy";
        case "completed":
          return "Applied network policy";
        case "failed":
          return "Network policy failed";
        case "skipped":
          return "Skipped network policy";
      }
      return "Apply network policy";
    }
  }
}

function BlockedSessionState({
  message,
  errorCode,
}: {
  message: string;
  errorCode: string | null;
}) {
  const githubReauth = useGitHubReauth();
  const [installUrl, setInstallUrl] = useState<string | null>(() => {
    if (errorCode !== "REPO_ACCESS_BLOCKED") {
      return null;
    }

    const cachedRepos = readCache<ListReposResponse>(CACHE_KEY_REPOS);
    return cachedRepos?.data.installUrl ?? null;
  });

  useEffect(() => {
    if (errorCode !== "REPO_ACCESS_BLOCKED") {
      setInstallUrl(null);
      return;
    }

    const cachedRepos = readCache<ListReposResponse>(CACHE_KEY_REPOS);
    if (cachedRepos?.data.installUrl) {
      setInstallUrl(cachedRepos.data.installUrl);
      return;
    }

    let stale = false;

    void listRepos()
      .then((response) => {
        if (!stale) {
          setInstallUrl(response.installUrl);
        }
      })
      .catch(() => {
        if (!stale) {
          setInstallUrl(null);
        }
      });

    return () => {
      stale = true;
    };
  }, [errorCode]);

  return (
    <div className="w-full max-w-xl text-center">
      <div className="flex flex-col items-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground">
          <GithubIcon className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-foreground">
          {errorCode === "GITHUB_AUTH_REQUIRED"
            ? "Reconnect GitHub"
            : "Repository access blocked"}
        </h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-foreground-secondary">
          {errorCode === "GITHUB_AUTH_REQUIRED"
            ? "Your GitHub credentials are no longer available. Please reauthenticate."
            : message}
        </p>
        {errorCode === "GITHUB_AUTH_REQUIRED" && (
          <button
            type="button"
            onClick={() => void githubReauth.reconnect().then((ok) => {
              if (ok) {
                window.location.reload();
              }
            })}
            disabled={githubReauth.isReauthing}
            className="mt-5 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-control-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            {githubReauth.isReauthing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <GithubIcon className="h-4 w-4" />
            )}
            Reconnect GitHub
          </button>
        )}
        {githubReauth.error && (
          <p className="mt-3 text-xs text-danger">{githubReauth.error}</p>
        )}
        {errorCode === "REPO_ACCESS_BLOCKED" && installUrl && (
          <Link
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm font-medium text-foreground hover:bg-background transition-colors"
          >
            <svg
              className="h-4 w-4 shrink-0"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            Update GitHub App access
          </Link>
        )}
      </div>
    </div>
  );
}
