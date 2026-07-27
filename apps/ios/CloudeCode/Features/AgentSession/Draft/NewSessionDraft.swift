import API
import AuthenticationServices
import CoreAPI
import Domain
import Entities
import Foundation
import SwiftUI

@MainActor
@Observable
final class NewSessionDraft {
    struct SelectedRepo: Equatable, Identifiable {
        let id: Int
        let fullName: String
        let defaultBranch: String
    }

    /// Repo selection with the branch and environment nested inside it, so
    /// clearing or replacing the repo can never leave a stale branch or
    /// environment behind.
    struct RepoSelection: Equatable {
        let repo: SelectedRepo
        var branch: String
        var environmentId: String?
    }

    private let sessionsAPI: any SessionsAPIProviding
    private let reposAPI: any ReposAPIProviding
    private let environmentsStore: RepoEnvironmentsStore
    private let preferences: NewSessionPreferences
    private let githubInstallationStore: GitHubInstallationStore
    private var branchesByRepoID: [Int: [Branch]] = [:]
    /// Repos whose environment load failed with nothing cached; treated as
    /// empty so the picker doesn't stay in its loading state forever.
    private var environmentsUnavailableRepoIDs: Set<Int> = []

    private(set) var repos: [Repo] = []
    private(set) var isLoading = false
    private(set) var isLoadingRepos = false
    private(set) var errorMessage: String?

    var isManagingGitHubRepositories: Bool {
        githubInstallationStore.state == .installing
    }

    var githubRepositoryManagementError: String? {
        guard case .failed(let message) = githubInstallationStore.state else {
            return nil
        }
        return message
    }

    var repoSelection: RepoSelection?

    var selectedRepo: SelectedRepo? {
        repoSelection?.repo
    }

    var selectedBranch: String? {
        repoSelection?.branch
    }

    var selectedEnvironmentId: String? {
        repoSelection?.environmentId
    }

    /// Environments for the selected repo. nil while nothing has been served
    /// yet from cache or network (the picker renders a redacted chip).
    var environments: [Domain.RepoEnvironment]? {
        guard let repo = selectedRepo else {
            return nil
        }
        if let environments = environmentsStore.environments(repoId: repo.id) {
            return environments
        }
        return environmentsUnavailableRepoIDs.contains(repo.id) ? [] : nil
    }

    var selectedEnvironment: Domain.RepoEnvironment? {
        guard let selectedEnvironmentId else {
            return nil
        }
        return environments?.first { $0.id == selectedEnvironmentId }
    }

    init(
        sessionsAPI: any SessionsAPIProviding,
        reposAPI: any ReposAPIProviding,
        environmentsStore: RepoEnvironmentsStore,
        preferences: NewSessionPreferences,
        githubInstallationStore: GitHubInstallationStore
    ) {
        self.sessionsAPI = sessionsAPI
        self.reposAPI = reposAPI
        self.environmentsStore = environmentsStore
        self.preferences = preferences
        self.githubInstallationStore = githubInstallationStore
        repoSelection = preferences.lastSelectedRepo.map {
            RepoSelection(
                repo: SelectedRepo(
                    id: $0.id,
                    fullName: $0.fullName,
                    defaultBranch: $0.defaultBranch
                ),
                branch: $0.defaultBranch,
                environmentId: preferences.lastEnvironmentId(repoId: $0.id)
            )
        }
    }

    /// Opens GitHub App repository management and refreshes the listing on return.
    func manageGitHubRepositories(using webSession: WebAuthenticationSession) async {
        await githubInstallationStore.install(using: webSession)
        await reloadRepos()
    }

    /// Loads repository defaults for the draft screen.
    func load() async {
        guard !isLoading else {
            return
        }
        isLoading = true
        isLoadingRepos = true
        errorMessage = nil
        defer {
            isLoading = false
            isLoadingRepos = false
        }

        do {
            let reposResponse = try await reposAPI.listRepos(limit: 50, cursor: nil)
            repos = reposResponse.repos
            resolveSelectedRepo(with: reposResponse.repos)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reloadRepos() async {
        isLoadingRepos = true
        defer { isLoadingRepos = false }

        do {
            let response = try await reposAPI.listRepos(limit: 50, cursor: nil)
            repos = response.repos
            resolveSelectedRepo(with: response.repos)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Searches repositories by query, falling back to the first loaded page when empty.
    func searchRepos(query: String, limit: Int = 50) async throws -> [Repo] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else {
            if repos.isEmpty {
                let response = try await reposAPI.listRepos(limit: limit, cursor: nil)
                repos = response.repos
            }
            return repos
        }
        return try await reposAPI.searchRepos(query: trimmedQuery, limit: limit).repos
    }

    /// Returns the branches cached for a repository during this draft session.
    func cachedBranches(repoId: Int) -> [Branch]? {
        branchesByRepoID[repoId]
    }

    /// Loads and caches the branches available for a repository.
    func branches(repoId: Int, limit: Int = 100) async throws -> [Branch] {
        if let cachedBranches = branchesByRepoID[repoId] {
            return cachedBranches
        }

        let branches = try await reposAPI.branches(repoId: repoId, limit: limit, cursor: nil).branches
        branchesByRepoID[repoId] = branches
        return branches
    }

    /// Repos most recently used to create sessions, newest first.
    var recentRepos: [NewSessionPreferences.RepoSnapshot] {
        preferences.recentRepos
    }

    /// Selects a repository and branch, resetting to the repository default when no branch is supplied.
    func selectRepo(_ repo: Repo, branch: String? = nil) {
        selectRepo(
            NewSessionPreferences.RepoSnapshot(
                id: repo.id,
                fullName: repo.fullName,
                defaultBranch: repo.defaultBranch
            ),
            branch: branch
        )
    }

    /// Selects a repository from a persisted snapshot (e.g. the recents list),
    /// which may not be present in the loaded repo listing.
    func selectRepo(_ snapshot: NewSessionPreferences.RepoSnapshot, branch: String? = nil) {
        // Re-selecting the same repo (e.g. refreshing a restored selection)
        // keeps its resolved environment. A different repo seeds its persisted
        // selection immediately so a cache-first load cannot briefly submit
        // with no environment while the network refresh is still in flight.
        let environmentId = repoSelection?.repo.id == snapshot.id
            ? repoSelection?.environmentId
            : preferences.lastEnvironmentId(repoId: snapshot.id)
        repoSelection = RepoSelection(
            repo: SelectedRepo(
                id: snapshot.id,
                fullName: snapshot.fullName,
                defaultBranch: snapshot.defaultBranch
            ),
            branch: branch ?? snapshot.defaultBranch,
            environmentId: environmentId
        )
        preferences.lastSelectedRepo = snapshot
    }

    /// Selects a branch for the current repository.
    func selectBranch(_ branch: String) {
        repoSelection?.branch = branch
    }

    /// Selects an environment for the current repository and remembers it.
    func selectEnvironment(_ environmentId: String?) {
        guard let repo = selectedRepo else {
            return
        }
        repoSelection?.environmentId = environmentId
        preferences.persistEnvironmentId(environmentId, repoId: repo.id)
    }

    /// Loads environments for the selected repo and resolves the draft's
    /// selection. Reuses the in-memory list unless a refresh is requested.
    func loadEnvironments(forceRefresh: Bool = false) async {
        guard let repo = selectedRepo else {
            return
        }
        do {
            try await environmentsStore.load(repoId: repo.id, forceRefresh: forceRefresh)
            environmentsUnavailableRepoIDs.remove(repo.id)
        } catch {
            if environmentsStore.environments(repoId: repo.id) == nil {
                environmentsUnavailableRepoIDs.insert(repo.id)
            }
        }
        resolveSelectedEnvironment(repoId: repo.id)
    }

    /// Builds and sends the create-session request for this draft.
    func createSession(
        content: String,
        attachmentIds: [String],
        model: ModelSelection
    ) async throws -> CreateSessionResponse {
        guard let repoSelection else {
            throw DraftError.repoRequired
        }

        let content = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let initialMessage = CreateSessionInitialMessage(
            content: content.isEmpty ? nil : content,
            attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds
        )
        let branch = repoSelection.branch == repoSelection.repo.defaultBranch ? nil : repoSelection.branch
        let request = CreateSessionRequest(
            repoId: repoSelection.repo.id,
            environmentId: repoSelection.environmentId,
            settings: AgentSettingsInput(
                provider: model.providerId,
                model: model.modelId,
                effort: model.effortId
            ),
            branch: branch,
            initialMessage: initialMessage
        )
        let response = try await sessionsAPI.createSession(request)
        preferences.recordRecentRepo(NewSessionPreferences.RepoSnapshot(
            id: repoSelection.repo.id,
            fullName: repoSelection.repo.fullName,
            defaultBranch: repoSelection.repo.defaultBranch
        ))
        return response
    }

    /// Mirrors web: keep the persisted last-used environment when it still
    /// exists, otherwise fall back to the first environment, else none.
    /// Reads the store directly so a failed load (fallback empty list) never
    /// clears a persisted selection.
    private func resolveSelectedEnvironment(repoId: Int) {
        guard repoSelection?.repo.id == repoId,
              let environments = environmentsStore.environments(repoId: repoId) else {
            return
        }
        let persistedId = preferences.lastEnvironmentId(repoId: repoId)
        let resolved = environments.first { $0.id == persistedId } ?? environments.first
        repoSelection?.environmentId = resolved?.id
        preferences.persistEnvironmentId(resolved?.id, repoId: repoId)
    }

    private func resolveSelectedRepo(with loadedRepos: [Repo]) {
        if let repoSelection,
           let repo = loadedRepos.first(where: { $0.id == repoSelection.repo.id }) {
            // A restored selection's branch is just the default branch we
            // persisted; follow the freshly loaded default in case it changed.
            let branch = repoSelection.branch == repoSelection.repo.defaultBranch
                ? repo.defaultBranch
                : repoSelection.branch
            selectRepo(repo, branch: branch)
            return
        }

        repoSelection = nil
    }
}

private enum DraftError: LocalizedError {
    case repoRequired

    var errorDescription: String? {
        switch self {
        case .repoRequired:
            "Select a repository before sending."
        }
    }
}
