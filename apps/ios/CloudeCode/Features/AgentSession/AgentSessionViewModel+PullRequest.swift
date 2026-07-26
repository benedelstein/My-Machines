import API
import CoreAPI
import Domain
import Entities
import Foundation

extension AgentSessionViewModel {
    var isPullRequestCreationInProgress: Bool {
        if case .creating = clientState.pullRequest {
            return true
        }
        return isCreatingPullRequest
    }

    var pullRequestErrorMessage: String? {
        if let pullRequestOperationErrorMessage {
            return pullRequestOperationErrorMessage
        }
        guard case .failed(let error, let details) = clientState.pullRequest else {
            return nil
        }
        return details ?? error
    }

    var createdPullRequestURL: URL? {
        guard case .created(let url, _, _) = clientState.pullRequest else {
            return nil
        }
        return URL(string: url)
    }

    /// Creates a pull request for the session's pushed branch.
    /// - Returns: The created pull request URL, or `nil` when creation fails.
    func createPullRequest() async -> URL? {
        guard let session, !isCreatingPullRequest else {
            return nil
        }

        isCreatingPullRequest = true
        pullRequestOperationErrorMessage = nil
        defer {
            isCreatingPullRequest = false
        }

        do {
            let response = try await sessionsAPI.createPullRequest(sessionId: session.id)
            applyPullRequest(
                url: response.url,
                number: response.number,
                state: response.state
            )
            return URL(string: response.url)
        } catch {
            Logger.error(error)
            pullRequestOperationErrorMessage = error.localizedDescription
            return nil
        }
    }

    /// Refreshes the current pull request status from GitHub through the session API.
    func refreshPullRequestStatus() async {
        guard let session else {
            return
        }

        do {
            let response = try await sessionsAPI.pullRequest(sessionId: session.id)
            applyPullRequest(
                url: response.url,
                number: response.number,
                state: response.merged ? "merged" : response.state
            )
        } catch {
            // Status refresh is best-effort; live session state remains usable.
            Logger.error(error)
        }
    }

    func reconcilePullRequestState() {
        if clientState.pullRequest != nil {
            pullRequestOperationErrorMessage = nil
        }
        updatePullRequestPolling()
    }

    func updatePullRequestPolling() {
        guard isBound, isOpenPullRequest else {
            stopPullRequestPolling()
            return
        }
        guard pullRequestPollingTask == nil else {
            return
        }

        pullRequestPollingTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else {
                    return
                }
                await self.refreshPullRequestStatus()
                guard !Task.isCancelled else {
                    return
                }
                do {
                    try await Task.sleep(for: self.pullRequestPollInterval)
                } catch {
                    return
                }
            }
        }
    }

    func stopPullRequestPolling() {
        pullRequestPollingTask?.cancel()
        pullRequestPollingTask = nil
    }

    private var isOpenPullRequest: Bool {
        guard case .created(_, _, let state) = clientState.pullRequest else {
            return false
        }
        return state == "open"
    }

    private func applyPullRequest(url: String, number: Int, state: String) {
        let pullRequest = SessionClientState.PullRequest.created(
            url: url,
            number: number,
            state: state
        )
        if clientState.pullRequest != pullRequest {
            clientState.pullRequest = pullRequest
        }

        if let session {
            let summaryPullRequest = Domain.SessionSummary.PullRequest(
                url: url,
                number: number,
                state: state
            )
            if session.pullRequest != summaryPullRequest {
                session.pullRequest = summaryPullRequest
                sessionSummaryStore.save([session])
            }
        }

        pullRequestOperationErrorMessage = nil
        updatePullRequestPolling()
        persistClientState()
    }
}
