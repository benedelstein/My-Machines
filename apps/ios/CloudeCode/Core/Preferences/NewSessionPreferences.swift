import Foundation

/// Persists the user's last valid model and repository choices for new sessions.
final class NewSessionPreferences {
    // These snapshot types are deliberately separate from the API/domain models:
    // they define a stable on-disk schema so changes to the API models can't
    // silently invalidate stored preferences, and they only persist the fields
    // needed to restore a selection.
    struct LastSelectedModel: Codable, Equatable {
        let providerId: String
        let modelId: String
        let displayName: String
        let effortId: String?
        let effortDisplayName: String?
    }

    struct RepoSnapshot: Codable, Equatable {
        let id: Int
        let fullName: String
        let defaultBranch: String
    }

    private static let maxRecentRepos: Int = 3

    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults) {
        self.userDefaults = userDefaults
    }

    var lastSelectedModel: LastSelectedModel? {
        get {
            userDefaults.codableValue(
                LastSelectedModel.self,
                forKey: Constants.UserDefaults.lastSelectedNewSessionModel
            )
        }
        set {
            userDefaults.setCodableValue(newValue, forKey: Constants.UserDefaults.lastSelectedNewSessionModel)
        }
    }

    /// Repos most recently used to create sessions, newest first. The first
    /// entry doubles as the repo preselected in a new session draft.
    var recentRepos: [RepoSnapshot] {
        userDefaults.codableValue([RepoSnapshot].self, forKey: Constants.UserDefaults.recentNewSessionRepos) ?? []
    }

    /// Moves a repo to the front of the recents list after a session is created.
    func recordRecentRepo(_ repo: RepoSnapshot) {
        var recents = recentRepos.filter { $0.id != repo.id }
        recents.insert(repo, at: 0)
        userDefaults.setCodableValue(
            Array(recents.prefix(Self.maxRecentRepos)),
            forKey: Constants.UserDefaults.recentNewSessionRepos
        )
    }

    /// Returns the last environment selected for a repository, if any.
    func lastEnvironmentId(repoId: Int) -> String? {
        userDefaults.string(forKey: environmentKey(repoId: repoId))
    }

    /// Persists the environment selected for a repository; nil clears it.
    func persistEnvironmentId(_ environmentId: String?, repoId: Int) {
        let key = environmentKey(repoId: repoId)
        if let environmentId {
            userDefaults.set(environmentId, forKey: key)
        } else {
            userDefaults.removeObject(forKey: key)
        }
    }

    private func environmentKey(repoId: Int) -> String {
        Constants.UserDefaults.lastEnvironmentIdPrefix + String(repoId)
    }
}
