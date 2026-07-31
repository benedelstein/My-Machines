import Domain
import Foundation
import Observation
import SwiftData

/// Per-repo environment cache backed by `EntityStore`: serves the disk cache
/// first, then reconciles with the server list.
@MainActor
@Observable
public final class RepoEnvironmentsStore {
    @ObservationIgnored private let entityStore: EntityStore<RepoEnvironmentModel>
    @ObservationIgnored private let listAPI: @Sendable (Int) async throws -> [Domain.RepoEnvironment]
    @ObservationIgnored private var loadTasksByRepoID: [Int: Task<Void, Error>] = [:]
    @ObservationIgnored private var loadGeneration: Int = 0

    /// Environments per repo id. `nil` for a repo means nothing has been
    /// served yet from either disk or network (drive loading UI off this).
    public private(set) var environmentsByRepoID: [Int: [Domain.RepoEnvironment]] = [:]

    /// Creates a repo environments store.
    ///
    /// - Parameters:
    ///   - cache: Disk cache; pass nil for memory-only behavior.
    ///   - listAPI: Fetches the canonical environment list for a repo id.
    public init(
        cache: Cache? = nil,
        listAPI: @escaping @Sendable (Int) async throws -> [Domain.RepoEnvironment]
    ) {
        entityStore = EntityStore(cache: cache)
        self.listAPI = listAPI
    }

    /// Returns the environments served so far for a repo, or nil when unloaded.
    public func environments(repoId: Int) -> [Domain.RepoEnvironment]? {
        environmentsByRepoID[repoId]
    }

    /// Inserts or replaces a canonical environment in memory immediately and
    /// schedules the same snapshot for persistence.
    public func upsert(_ environment: Domain.RepoEnvironment) {
        var environments = environmentsByRepoID[environment.repoId] ?? []
        if let index = environments.firstIndex(where: { $0.id == environment.id }) {
            environments[index] = environment
        } else {
            environments.append(environment)
        }
        environmentsByRepoID[environment.repoId] = Self.sorted(environments)
        entityStore.putSnapshotsToDisk([environment])
    }

    /// Clears all environments from memory and disk and cancels in-flight loads.
    public func deleteAll() async throws {
        loadGeneration += 1
        for task in loadTasksByRepoID.values {
            task.cancel()
        }
        loadTasksByRepoID.removeAll()
        environmentsByRepoID.removeAll()
        try await entityStore.deleteAll()
    }

    /// Loads a repo's environments, reusing an in-memory list unless a refresh
    /// is explicitly requested. A cache miss serves disk first, then refreshes
    /// from the network, upserts fresh rows, and prunes stale ones.
    /// Concurrent calls for the same repo share one in-flight load.
    public func load(repoId: Int, forceRefresh: Bool = false) async throws {
        if !forceRefresh, environmentsByRepoID[repoId] != nil {
            return
        }

        if let task = loadTasksByRepoID[repoId] {
            try await task.value
            return
        }

        let generation = loadGeneration
        let task = Task { [weak self] in
            defer {
                if self?.loadGeneration == generation {
                    self?.loadTasksByRepoID[repoId] = nil
                }
            }
            try await self?.performLoad(repoId: repoId, generation: generation)
        }
        loadTasksByRepoID[repoId] = task
        try await task.value
    }

    private func performLoad(repoId: Int, generation: Int) async throws {
        if environmentsByRepoID[repoId] == nil {
            let cached = try? await entityStore.snapshotsFromDisk(
                predicate: #Predicate<RepoEnvironmentEntity> { $0.repoId == repoId },
                sortBy: [
                    SortDescriptor(\.updatedAt, order: .reverse),
                    SortDescriptor(\.name)
                ]
            )
            guard loadGeneration == generation, !Task.isCancelled else {
                throw CancellationError()
            }
            if let cached, !cached.isEmpty {
                environmentsByRepoID[repoId] = Self.sorted(cached)
            }
        }

        let fresh = try await listAPI(repoId)
        guard loadGeneration == generation, !Task.isCancelled else {
            throw CancellationError()
        }
        let freshIDs = Set(fresh.map(\.id))
        let staleIDs = Set((environmentsByRepoID[repoId] ?? []).map(\.id)).subtracting(freshIDs)
        entityStore.delete(staleIDs)
        entityStore.putSnapshotsToDisk(fresh)
        environmentsByRepoID[repoId] = Self.sorted(fresh)
    }

    private static func sorted(
        _ environments: [Domain.RepoEnvironment]
    ) -> [Domain.RepoEnvironment] {
        environments.sorted { lhs, rhs in
            if lhs.updatedAt != rhs.updatedAt {
                return lhs.updatedAt > rhs.updatedAt
            }
            return lhs.name < rhs.name
        }
    }
}
