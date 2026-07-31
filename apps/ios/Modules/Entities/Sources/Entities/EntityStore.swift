import Domain
import Foundation
import Observation
import os
import SwiftData

public struct FetchScope: OptionSet, Sendable {
    public let rawValue: Int

    public init(rawValue: Int) {
        self.rawValue = rawValue
    }

    public static let memory: FetchScope = FetchScope(rawValue: 1 << 0)
    public static let disk: FetchScope = FetchScope(rawValue: 1 << 1)
    public static let network: FetchScope = FetchScope(rawValue: 1 << 2)

    public static let all: FetchScope = [.memory, .disk, .network]
}

/// Identity-mapped store of `EntityModel`s with a memory → disk → network
/// fetch cascade.
///
/// Disk (via `Cache` and `M.EntityType`) and network sources speak `Snapshot`
/// (Sendable domain structs), never model classes — struct → class mapping
/// happens only here, on the main actor. That is what lets models be
/// `@MainActor` instead of `@unchecked Sendable`.
@MainActor
@Observable
public final class EntityStore<M: EntityModel> {
    public typealias Snapshot = M.Snapshot

    public private(set) var objectMap: [String: M] = [:]

    @ObservationIgnored private let cache: Cache?
    @ObservationIgnored private let getAPI: (@Sendable (Set<String>) async throws -> [Snapshot])?

    public init(
        cache: Cache? = nil,
        getAPI: (@Sendable (Set<String>) async throws -> [Snapshot])? = nil
    ) {
        self.cache = cache
        self.getAPI = getAPI
    }

    // MARK: - Getters

    public subscript(_ id: String) -> M? {
        objectMap[id]
    }

    public func getFromMemory(_ ids: Set<String>) -> [M] {
        ids.compactMap { objectMap[$0] }
    }

    public func getFromDisk(_ ids: Set<String>) async throws -> [M] {
        guard let cache else { return [] }

        let snapshots = try await cache.fetch(M.EntityType.self, ids: ids)
        Logger.debug("got \(snapshots.count) of \(ids.count) \(M.self) from disk")
        return putMemory(snapshots)
    }

    /// Predicate/sort-based disk fetch (e.g. for list screens). Results merge
    /// into the identity map like any other disk read.
    public func getFromDisk(
        predicate: Predicate<M.EntityType>? = nil,
        sortBy: [SortDescriptor<M.EntityType>] = [],
        limit: Int? = nil
    ) async throws -> [M] {
        guard let cache else { return [] }
        let d0 = Date()

        let snapshots = try await cache.fetch(
            M.EntityType.self,
            predicate: predicate,
            sortBy: sortBy,
            limit: limit
        )
        Logger.debug(
            "got \(snapshots.count) \(M.self) from disk by predicate in \(Date.now.timeIntervalSince(d0) * 1000)ms"
        )
        return putMemory(snapshots)
    }

    /// Fetches snapshots from disk without inserting them into the in-memory identity map.
    public func snapshotsFromDisk(
        predicate: Predicate<M.EntityType>? = nil,
        sortBy: [SortDescriptor<M.EntityType>] = [],
        limit: Int? = nil
    ) async throws -> [Snapshot] {
        guard let cache else { return [] }
        return try await cache.fetch(
            M.EntityType.self,
            predicate: predicate,
            sortBy: sortBy,
            limit: limit
        )
    }

    /// Loads all cached rows for this entity into the identity map.
    @discardableResult
    public func load() async throws -> [M] {
        try await getFromDisk()
    }

    public func count(predicate: Predicate<M.EntityType>? = nil) async throws -> Int {
        guard let cache else { return 0 }

        return try await cache.count(M.EntityType.self, predicate: predicate)
    }

    public func get(_ ids: Set<String>, scopes: FetchScope = .all) async throws -> [M] {
        guard !ids.isEmpty, !scopes.isEmpty else { return [] }

        var results: [M] = []
        var missingIds = ids

        if scopes.contains(.memory) {
            let fromMemory = getFromMemory(ids)
            results.append(contentsOf: fromMemory)
            missingIds.subtract(fromMemory.map(\.id))
        }

        if !missingIds.isEmpty, scopes.contains(.disk) {
            let fromDisk = try await getFromDisk(missingIds)
            results.append(contentsOf: fromDisk)
            missingIds.subtract(fromDisk.map(\.id))
        }

        if !missingIds.isEmpty, let getAPI, scopes.contains(.network) {
            let fromNetwork = try await getAPI(missingIds)
            results.append(contentsOf: putSnapshotsToDisk(fromNetwork))
            missingIds.subtract(fromNetwork.map(\.id))
        }

        if !missingIds.isEmpty {
            Logger.warning("missing \(missingIds.count) of \(ids.count) \(M.self) requested")
        }

        return results
    }

    // MARK: - Setters

    /// Merges snapshots into the identity map: existing instances are updated
    /// in place (preserving reference identity), unknown ids are inserted.
    @discardableResult
    public func putMemory(_ snapshots: [Snapshot]) -> [M] {
        guard !snapshots.isEmpty else { return [] }

        for snapshot in snapshots {
            if let cached = objectMap[snapshot.id] {
                cached.update(from: snapshot)
            } else {
                objectMap[snapshot.id] = M(snapshot)
            }
        }

        return snapshots.compactMap { objectMap[$0.id] }
    }

    /// Removes models from the in-memory identity map without touching disk.
    public func deleteMemory(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }

        for id in ids {
            objectMap.removeValue(forKey: id)
        }
    }

    /// Merges snapshots into canonical models, then persists them to disk in the background.
    ///
    /// - Parameter snapshots: Snapshots received from the API, socket, or other external source.
    /// - Returns: The canonical models corresponding to the supplied snapshots.
    @discardableResult
    public func putSnapshotsToDisk(_ snapshots: [Snapshot]) -> [M] {
        guard !snapshots.isEmpty else { return [] }

        if let cache {
            Task {
                do {
                    try await cache.put(M.EntityType.self, snapshots: snapshots)
                } catch {
                    Logger.error("disk write failed: \(error)")
                }
            }
        }

        return putMemory(snapshots)
    }

    /// Persists current model state (e.g. after view-side mutations).
    ///
    /// - returns:  the canonical cached model instances, not necessarily the ones you passed in.
    @discardableResult
    public func save(_ models: [M]) -> [M] {
        putSnapshotsToDisk(models.map(\.snapshot))
    }

    // MARK: - Delete

    /// Removes from memory and disk.
    public func delete(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }

        if let cache {
            Task {
                do {
                    try await cache.delete(M.EntityType.self, ids: ids)
                } catch {
                    Logger.error("disk delete failed: \(error)")
                }
            }
        }

        for id in ids {
            objectMap.removeValue(forKey: id)
        }
    }

    /// Removes every canonical model from memory and deletes its persisted table rows.
    public func deleteAll() async throws {
        objectMap.removeAll()
        guard let cache else { return }
        try await cache.deleteAll(M.EntityType.self)
    }
}
