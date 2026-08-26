import { createElement, useState, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRepoGroup, SessionSummary } from "@repo/shared";
import { SidebarProvider } from "@/components/ui/sidebar";

const mocks = vi.hoisted(() => ({
  groups: [] as SessionRepoGroup[],
  loadMoreRepos: vi.fn(),
  loadMoreSessionsForRepo: vi.fn(),
  removeSession: vi.fn(),
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  logout: vi.fn(),
  toastError: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ sessionId: "open-pr" }),
  usePathname: () => "/sessions/open-pr",
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "user-1", login: "ben", name: "Ben", avatarUrl: null },
    loading: false,
    logout: mocks.logout,
  }),
}));

vi.mock("@/lib/client-api", () => ({
  archiveSession: mocks.archiveSession,
  deleteSession: mocks.deleteSession,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}));

vi.mock("@/components/providers/session-list-provider", () => ({
  useSessionList: () => ({
    groups: mocks.groups,
    loading: false,
    nextRepoCursor: null,
    loadingMoreRepos: false,
    loadingMoreSessionsByRepo: {},
    removeSession: mocks.removeSession,
    loadMoreRepos: mocks.loadMoreRepos,
    loadMoreSessionsForRepo: mocks.loadMoreSessionsForRepo,
  }),
}));

import { SessionSidebar } from "@/components/sidebar/session-sidebar";

afterEach(() => {
  cleanup();
});

function TestSessionListProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState(mocks.groups);
  mocks.groups = groups;
  mocks.removeSession.mockImplementation((sessionId: string) => {
    setGroups((currentGroups) =>
      currentGroups.map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => session.id !== sessionId),
      })),
    );
  });

  return children;
}

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: overrides.id ?? "session-1",
    repoId: 100,
    repoFullName: "acme/repo",
    title: overrides.title ?? "Session title",
    archived: false,
    workingState: overrides.workingState ?? "idle",
    pushedBranch: overrides.pushedBranch ?? null,
    pullRequest: overrides.pullRequest ?? null,
    createdAt: overrides.createdAt ?? "2026-05-24T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-24T12:00:00.000Z",
    lastMessageAt: overrides.lastMessageAt ?? null,
    lastAssistantMessageId: overrides.lastAssistantMessageId ?? null,
    hasUnread: overrides.hasUnread ?? false,
  };
}

function renderSidebar() {
  return render(
    createElement(
      SidebarProvider,
      null,
      createElement(
        TestSessionListProvider,
        null,
        createElement(SessionSidebar),
      ),
    ),
  );
}

describe("SessionSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date("2026-05-24T12:10:00.000Z"));
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    mocks.groups = [{
      repoId: 100,
      repoFullName: "acme/repo",
      nextSessionCursor: null,
      sessions: [
        makeSession({
          id: "responding",
          title: "Responding",
          workingState: "responding",
          pushedBranch: "codex/responding",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/1",
            number: 1,
            state: "open",
          },
          updatedAt: "2026-05-24T12:09:00.000Z",
        }),
        makeSession({
          id: "open-pr",
          title: "Open PR",
          pushedBranch: "codex/open",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/2",
            number: 2,
            state: "open",
          },
          updatedAt: "2026-05-24T12:05:00.000Z",
        }),
        makeSession({
          id: "unread",
          title: "Unread",
          lastAssistantMessageId: "assistant-message-1",
          hasUnread: true,
          updatedAt: "2026-05-24T12:08:00.000Z",
        }),
        makeSession({
          id: "closed-pr",
          title: "Closed PR",
          pushedBranch: "codex/closed",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/3",
            number: 3,
            state: "closed",
          },
          updatedAt: "2026-05-19T12:10:00.000Z",
        }),
        makeSession({
          id: "merged-pr",
          title: "Merged PR",
          pushedBranch: "codex/merged",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/4",
            number: 4,
            state: "merged",
          },
          updatedAt: "2026-05-10T12:10:00.000Z",
        }),
        makeSession({
          id: "branch-only",
          title: "Branch only",
          pushedBranch: "codex/branch",
          updatedAt: "2026-04-24T12:10:00.000Z",
        }),
        makeSession({
          id: "idle",
          title: "Idle",
          updatedAt: "2026-04-24T12:10:00.000Z",
        }),
      ],
    }];
  });

  it("renders artifact indicators on the left and attention indicators on the right", async () => {
    renderSidebar();

    expect(await screen.findByLabelText("Responding")).toBeTruthy();
    expect(screen.getByLabelText("Unread message")).toBeTruthy();
    expect(screen.getAllByLabelText("Open pull request")).toHaveLength(2);
    expect(screen.getByLabelText("Closed pull request")).toBeTruthy();
    expect(screen.getByLabelText("Merged pull request")).toBeTruthy();
    expect(screen.getByLabelText("Pushed branch")).toBeTruthy();

    const respondingRow = screen.getByText("Responding").closest("a");
    expect(respondingRow).toBeTruthy();
    expect(within(respondingRow as HTMLElement).getByLabelText("Responding")).toBeTruthy();
    expect(within(respondingRow as HTMLElement).getByLabelText("Open pull request")).toBeTruthy();

    const idleRow = screen.getByText("Idle").closest("a");
    expect(idleRow).toBeTruthy();
    expect(
      within(idleRow as HTMLElement).queryByLabelText(
        /Responding|pull request|Pushed branch/,
      ),
    ).toBeNull();
  });

  it("renders compact timestamps", async () => {
    renderSidebar();

    await waitFor(() => expect(screen.getByText("5m")).toBeTruthy());
    expect(screen.getByText("5m")).toBeTruthy();
    expect(screen.getByText("5d")).toBeTruthy();
    expect(screen.getByText("2w")).toBeTruthy();
    expect(screen.getAllByText("1mo")).toHaveLength(2);
  });

  it("collapses repo groups and starts new sessions with the repo preselected", async () => {
    renderSidebar();

    expect(screen.getByText("Open PR")).toBeTruthy();
    const repoToggle = screen.getByRole("button", { name: "repo" });
    expect(repoToggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(repoToggle);
    expect(repoToggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(repoToggle);
    expect(repoToggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "New session in repo" }));
    expect(mocks.push).toHaveBeenCalledWith(
      "/dashboard?repoId=100&repoFullName=acme%2Frepo",
    );
  });

  it("opens account actions from the profile menu", async () => {
    renderSidebar();

    const accountMenuTrigger = screen.getByRole("button", {
      name: "Open account menu",
    });
    fireEvent.pointerDown(accountMenuTrigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(accountMenuTrigger, { pointerType: "mouse" });
    fireEvent.click(accountMenuTrigger);
    fireEvent.keyDown(accountMenuTrigger, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("Ben")).toBeTruthy();
    expect(screen.getByText("@ben")).toBeTruthy();

    const settingsItem = await screen.findByRole("menuitem", {
      name: "Settings",
    });
    expect(settingsItem.getAttribute("href")).toBe("/settings");

    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    expect(mocks.logout).toHaveBeenCalledTimes(1);
  });

  it("optimistically removes deleted sessions without showing a row spinner", async () => {
    mocks.deleteSession.mockReturnValue(new Promise(() => undefined));
    renderSidebar();

    const openRow = screen.getByText("Open PR").closest("li");
    expect(openRow).toBeTruthy();
    const rowMenuTrigger = within(openRow as HTMLElement).getByRole("button");
    fireEvent.pointerDown(rowMenuTrigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(rowMenuTrigger, { pointerType: "mouse" });
    fireEvent.click(rowMenuTrigger);
    fireEvent.keyDown(rowMenuTrigger, { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(mocks.removeSession).toHaveBeenCalledWith("open-pr");
    expect(screen.queryByText("Open PR")).toBeNull();
    expect(screen.queryByLabelText("Deleting")).toBeNull();
  });

  it("shows a toast when session deletion fails", async () => {
    const error = new Error("Repository access could not be verified");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.deleteSession.mockRejectedValue(error);
    renderSidebar();

    const openRow = screen.getByText("Open PR").closest("li");
    expect(openRow).toBeTruthy();
    const rowMenuTrigger = within(openRow as HTMLElement).getByRole("button");
    fireEvent.pointerDown(rowMenuTrigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(rowMenuTrigger, { pointerType: "mouse" });
    fireEvent.click(rowMenuTrigger);
    fireEvent.keyDown(rowMenuTrigger, { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("Failed to delete session", {
        description: "Repository access could not be verified",
      });
    });
    expect(consoleError).toHaveBeenCalledWith("Failed to delete session:", error);
    consoleError.mockRestore();
  });
});
