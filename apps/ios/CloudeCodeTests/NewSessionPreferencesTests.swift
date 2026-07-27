@testable import CloudeCode
import Foundation
import Testing

@Suite("New session preferences recents")
struct NewSessionPreferencesTests {
    @Test func recordingKeepsNewestFirstAndCapsAtThree() throws {
        let (preferences, suiteName) = try makePreferences()
        defer { UserDefaults.standard.removePersistentDomain(forName: suiteName) }

        for id in 1 ... 4 {
            preferences.recordRecentRepo(snapshot(id: id))
        }

        #expect(preferences.recentRepos.map(\.id) == [4, 3, 2])
    }

    @Test func recordingExistingRepoMovesItToFront() throws {
        let (preferences, suiteName) = try makePreferences()
        defer { UserDefaults.standard.removePersistentDomain(forName: suiteName) }
        for id in 1 ... 3 {
            preferences.recordRecentRepo(snapshot(id: id))
        }

        preferences.recordRecentRepo(snapshot(id: 1))

        #expect(preferences.recentRepos.map(\.id) == [1, 3, 2])
    }

    @Test func legacyLastSelectedRepoSeedsEmptyRecentsOnce() throws {
        let suiteName = "NewSessionPreferencesTests.\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suiteName) }
        let userDefaults = try #require(UserDefaults(suiteName: suiteName))
        userDefaults.setCodableValue(
            snapshot(id: 1),
            forKey: Constants.UserDefaults.lastSelectedNewSessionRepo
        )

        let preferences = NewSessionPreferences(userDefaults: userDefaults)

        #expect(preferences.recentRepos.map(\.id) == [1])
        #expect(userDefaults.object(forKey: Constants.UserDefaults.lastSelectedNewSessionRepo) == nil)
    }

    @Test func legacyLastSelectedRepoDoesNotOverrideExistingRecents() throws {
        let suiteName = "NewSessionPreferencesTests.\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suiteName) }
        let userDefaults = try #require(UserDefaults(suiteName: suiteName))
        userDefaults.setCodableValue(
            [snapshot(id: 2)],
            forKey: Constants.UserDefaults.recentNewSessionRepos
        )
        userDefaults.setCodableValue(
            snapshot(id: 1),
            forKey: Constants.UserDefaults.lastSelectedNewSessionRepo
        )

        let preferences = NewSessionPreferences(userDefaults: userDefaults)

        #expect(preferences.recentRepos.map(\.id) == [2])
        #expect(userDefaults.object(forKey: Constants.UserDefaults.lastSelectedNewSessionRepo) == nil)
    }

    private func snapshot(id: Int) -> NewSessionPreferences.RepoSnapshot {
        NewSessionPreferences.RepoSnapshot(
            id: id,
            fullName: "owner/repo-\(id)",
            defaultBranch: "main"
        )
    }

    private func makePreferences() throws -> (NewSessionPreferences, String) {
        let suiteName = "NewSessionPreferencesTests.\(UUID().uuidString)"
        let userDefaults = try #require(UserDefaults(suiteName: suiteName))
        return (NewSessionPreferences(userDefaults: userDefaults), suiteName)
    }
}
