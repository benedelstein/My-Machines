import Domain
import Foundation
import XCTest
@testable import Entities

@MainActor
final class RepoEnvironmentsStoreTests: XCTestCase {
    private func makeCache() throws -> Cache {
        try Cache(container: ModelContainerFactory().make(inMemory: true))
    }

    private func makeMetadataStore() throws -> CacheMetadataStore {
        let suiteName = "RepoEnvironmentsStoreTests.\(UUID().uuidString)"
        let userDefaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        return CacheMetadataStore(userDefaults: userDefaults)
    }

    func testLoadServesNetworkListAndPersistsIt() async throws {
        let cache = try makeCache()
        let store = RepoEnvironmentsStore(cache: cache) { repoId in
            [testRepoEnvironment("e1", repoId: repoId), testRepoEnvironment("e2", repoId: repoId)]
        }

        XCTAssertNil(store.environments(repoId: 1))

        try await store.load(repoId: 1)

        XCTAssertEqual(store.environments(repoId: 1)?.map(\.id), ["e1", "e2"])
        let persisted = try await pollUntil {
            let rows = try await cache.fetch(RepoEnvironmentEntity.self, ids: ["e1", "e2"])
            return rows.count == 2 ? rows : nil
        }
        XCTAssertEqual(Set(persisted.map(\.id)), ["e1", "e2"])
    }

    func testLoadServesDiskCacheWhenNetworkFails() async throws {
        let cache = try makeCache()
        let seedStore = RepoEnvironmentsStore(cache: cache) { repoId in
            [testRepoEnvironment("e1", repoId: repoId)]
        }
        try await seedStore.load(repoId: 1)
        _ = try await pollUntil {
            let rows = try await cache.fetch(RepoEnvironmentEntity.self, ids: ["e1"])
            return rows.isEmpty ? nil : rows
        }

        let store = RepoEnvironmentsStore(cache: cache) { _ in
            throw URLError(.notConnectedToInternet)
        }

        // The cached list is published before the network refresh throws.
        await XCTAssertThrowsErrorAsync(try await store.load(repoId: 1))
        XCTAssertEqual(store.environments(repoId: 1)?.map(\.id), ["e1"])
    }

    func testLoadPrunesEnvironmentsDeletedOnServer() async throws {
        let cache = try makeCache()
        let responses = ResponseQueue([
            [testRepoEnvironment("e1"), testRepoEnvironment("stale")],
            [testRepoEnvironment("e1")]
        ])
        let store = RepoEnvironmentsStore(cache: cache) { _ in
            await responses.next()
        }

        try await store.load(repoId: 1)
        let seededStaleRows = try await pollUntil {
            let rows = try await cache.fetch(RepoEnvironmentEntity.self, ids: ["stale"])
            return rows.isEmpty ? nil : rows
        }
        XCTAssertEqual(seededStaleRows.map(\.id), ["stale"])

        try await store.load(repoId: 1, forceRefresh: true)

        XCTAssertEqual(store.environments(repoId: 1)?.map(\.id), ["e1"])
        let staleRows = try await pollUntil {
            let rows = try await cache.fetch(RepoEnvironmentEntity.self, ids: ["stale"])
            return rows.isEmpty ? rows : nil
        }
        XCTAssertTrue(staleRows.isEmpty)
    }

    func testLoadReusesMemoryUntilRefreshIsForced() async throws {
        let responses = ResponseQueue([
            [testRepoEnvironment("e1")],
            [testRepoEnvironment("e2")]
        ])
        let store = RepoEnvironmentsStore { _ in
            await responses.next()
        }

        try await store.load(repoId: 1)
        try await store.load(repoId: 1)

        XCTAssertEqual(store.environments(repoId: 1)?.map(\.id), ["e1"])

        try await store.load(repoId: 1, forceRefresh: true)

        XCTAssertEqual(store.environments(repoId: 1)?.map(\.id), ["e2"])
    }

    func testEnvironmentsAreScopedPerRepo() async throws {
        let store = RepoEnvironmentsStore { repoId in
            repoId == 1 ? [testRepoEnvironment("e1", repoId: 1)] : []
        }

        try await store.load(repoId: 1)
        try await store.load(repoId: 2)

        XCTAssertEqual(store.environments(repoId: 1)?.map(\.id), ["e1"])
        XCTAssertEqual(store.environments(repoId: 2), [])
    }

    func testEntityRoundTripsFullSnapshot() throws {
        let snapshot = testRepoEnvironment("e1")

        let roundTrip = try RepoEnvironmentEntity(snapshot).makeSnapshot()

        XCTAssertEqual(roundTrip, snapshot)
        XCTAssertEqual(RepoEnvironmentEntity.cacheVersion, 2)
    }

    func testLegacyPartialCacheVersionIsInvalidated() async throws {
        let metadataStore = try makeMetadataStore()
        metadataStore.setCacheVersion(Cache.version)
        metadataStore.setEntityVersion(1, for: RepoEnvironmentEntity.self)
        let cache = try Cache(
            container: ModelContainerFactory().make(inMemory: true),
            metadataStore: metadataStore
        )
        try await cache.put(
            RepoEnvironmentEntity.self,
            snapshots: [testRepoEnvironment("legacy")]
        )

        try await cache.start()

        let rows = try await cache.fetch(RepoEnvironmentEntity.self, ids: ["legacy"])
        XCTAssertTrue(rows.isEmpty)
        XCTAssertEqual(
            metadataStore.entityVersion(RepoEnvironmentEntity.self),
            RepoEnvironmentEntity.cacheVersion
        )
    }

    func testUpsertOrdersByUpdatedAtThenName() {
        let store = RepoEnvironmentsStore { _ in [] }
        let older = testRepoEnvironment(
            "older",
            name: "Zulu",
            updatedAt: "2026-07-12T00:00:00.000Z"
        )
        let alpha = testRepoEnvironment(
            "alpha",
            name: "Alpha",
            updatedAt: "2026-07-13T00:00:00.000Z"
        )
        let beta = testRepoEnvironment(
            "beta",
            name: "Beta",
            updatedAt: "2026-07-13T00:00:00.000Z"
        )

        store.upsert(older)
        store.upsert(beta)
        store.upsert(alpha)

        XCTAssertEqual(store.environments(repoId: 1)?.map(\.id), ["alpha", "beta", "older"])
        let updatedOlder = testRepoEnvironment(
            "older",
            name: "Newest",
            updatedAt: "2026-07-14T00:00:00.000Z"
        )
        store.upsert(updatedOlder)

        XCTAssertEqual(store.environments(repoId: 1)?.map(\.id), ["older", "alpha", "beta"])
    }

    func testUpsertPersistsFullSnapshot() async throws {
        let cache = try makeCache()
        let store = RepoEnvironmentsStore(cache: cache) { _ in [] }
        let updatedOlder = testRepoEnvironment(
            "older",
            name: "Newest",
            updatedAt: "2026-07-14T00:00:00.000Z"
        )

        store.upsert(updatedOlder)

        let persistedUpdate = try await pollUntil {
            try await cache.fetch(RepoEnvironmentEntity.self, ids: ["older"]).first == updatedOlder
                ? updatedOlder
                : nil
        }
        XCTAssertEqual(persistedUpdate, updatedOlder)
    }

    func testDeleteAllClearsLoadedEnvironments() async throws {
        let store = RepoEnvironmentsStore { repoId in
            [testRepoEnvironment("e1", repoId: repoId)]
        }
        try await store.load(repoId: 1)

        try await store.deleteAll()

        XCTAssertNil(store.environments(repoId: 1))
    }

    func testDeleteAllPreventsCancelledLoadFromRepopulatingMemory() async {
        let gate = EnvironmentLoadGate()
        let store = RepoEnvironmentsStore { _ in
            await gate.response()
        }
        let loadTask = Task { try? await store.load(repoId: 1) }
        while await !gate.didStart {
            await Task.yield()
        }

        try? await store.deleteAll()
        await gate.resume(with: [testRepoEnvironment("stale")])
        await loadTask.value

        XCTAssertNil(store.environments(repoId: 1))
    }
}

/// Serves canned responses in order, repeating the last one.
private actor ResponseQueue {
    private var responses: [[Domain.RepoEnvironment]]

    init(_ responses: [[Domain.RepoEnvironment]]) {
        self.responses = responses
    }

    func next() -> [Domain.RepoEnvironment] {
        responses.count > 1 ? responses.removeFirst() : responses[0]
    }
}

private actor EnvironmentLoadGate {
    private(set) var didStart: Bool = false
    private var continuation: CheckedContinuation<[Domain.RepoEnvironment], Never>?

    func response() async -> [Domain.RepoEnvironment] {
        didStart = true
        return await withCheckedContinuation { continuation = $0 }
    }

    func resume(with environments: [Domain.RepoEnvironment]) {
        continuation?.resume(returning: environments)
        continuation = nil
    }
}

/// Asserts that an async expression throws.
@MainActor
private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("expected expression to throw", file: file, line: line)
    } catch {}
}
