import Domain
import Foundation
import SwiftData

/// Stores cache lifecycle metadata outside SwiftData so the cache can decide
/// whether persisted rows are safe to read.
public final class CacheMetadataStore: @unchecked Sendable {
    private let userDefaults: UserDefaults
    private let cacheVersionKey: String

    /// Creates a metadata store backed by `UserDefaults`.
    public init(
        userDefaults: UserDefaults = .standard,
        cacheVersionKey: String = "cache.version"
    ) {
        self.userDefaults = userDefaults
        self.cacheVersionKey = cacheVersionKey
    }

    /// Returns the stored cache version, or nil when this app install has not
    /// recorded one yet.
    public func cacheVersion() -> Int? {
        guard userDefaults.object(forKey: cacheVersionKey) != nil else { return nil }
        return userDefaults.integer(forKey: cacheVersionKey)
    }

    /// Persists the cache version that was last prepared for use.
    public func setCacheVersion(_ version: Int) {
        userDefaults.set(version, forKey: cacheVersionKey)
    }

    /// Returns the stored cache version for an entity type.
    public func entityVersion(_ type: any Entity.Type) -> Int? {
        guard userDefaults.object(forKey: type.cacheVersionKey) != nil else { return nil }
        return userDefaults.integer(forKey: type.cacheVersionKey)
    }

    /// Persists the cache version for an entity type.
    public func setEntityVersion(_ version: Int, for type: any Entity.Type) {
        userDefaults.set(version, forKey: type.cacheVersionKey)
    }
}

/// SwiftData persistence runner, ported from Gallery.
///
/// Work runs on a `DataHandler` model actor created on a background queue —
/// a `@ModelActor`'s executor is bound to where it was created, so creating
/// one on the main thread would run "background" work on main.
public final class Cache: Sendable {
    /// Increment this version to reset the whole cache.
    public static let version: Int = 1

    private let container: ModelContainer
    private let metadataStore: CacheMetadataStore
    private let startCoordinator: CacheStartCoordinator = CacheStartCoordinator()
    private let backgroundQueue: DispatchQueue = DispatchQueue(label: "llc.bze.CloudeCode.cache")

    /// Creates a cache around a SwiftData container.
    public init(
        container: ModelContainer,
        metadataStore: CacheMetadataStore = CacheMetadataStore()
    ) {
        self.container = container
        self.metadataStore = metadataStore
    }

    /// Prepares the cache for use, resetting stored rows when the recorded
    /// cache version is older than `Cache.version`.
    public func start() async throws {
        try await startCoordinator.start { [metadataStore] in
            guard let storedVersion = metadataStore.cacheVersion() else {
                Logger.debug("Cache version missing, resetting for \(Self.version)")
                try await self.reset()
                metadataStore.setCacheVersion(Self.version)
                try await self.startEntities()
                return
            }

            if storedVersion < Self.version {
                Logger.debug("Cache outdated - \(storedVersion), resetting for \(Self.version)")
                try await self.reset()
                metadataStore.setCacheVersion(Self.version)
            } else if storedVersion > Self.version {
                Logger.warning(
                    "Stored cache version \(storedVersion) is newer than app cache version \(Self.version)"
                )
            }

            try await self.startEntities()
        }
    }

    /// Deletes all cached SwiftData rows.
    public func reset() async throws {
        for model in CurrentSchema.models {
            try await runBackgroundTask { context in
                try context.delete(model: model)
            }
        }
    }

    func runBackgroundTask<T: Sendable>(
        block: @Sendable @escaping (ModelContext) throws -> T
    ) async throws -> T {
        let handler = backgroundQueue.sync {
            DataHandler(modelContainer: container)
        }
        return try await handler.execute(block: block)
    }

    private func startEntities() async throws {
        for entity in CurrentSchema.entities {
            try await startEntity(entity)
        }
    }

    private func startEntity(_ type: any Entity.Type) async throws {
        guard let storedVersion = metadataStore.entityVersion(type) else {
            metadataStore.setEntityVersion(type.cacheVersion, for: type)
            return
        }

        if storedVersion < type.cacheVersion {
            Logger.debug(
                "\(String(describing: type)) cache outdated - \(storedVersion), resetting for \(type.cacheVersion)"
            )
            try await runBackgroundTask { context in
                try type.deleteAll(in: context)
            }
            metadataStore.setEntityVersion(type.cacheVersion, for: type)
        } else if storedVersion > type.cacheVersion {
            Logger.warning(
                "Stored \(String(describing: type)) cache version \(storedVersion) is newer " +
                    "than app cache version \(type.cacheVersion)"
            )
        }
    }
}

private actor CacheStartCoordinator {
    private var startTask: Task<Void, Error>?

    func start(operation: @Sendable @escaping () async throws -> Void) async throws {
        if let startTask {
            return try await startTask.value
        }

        let task = Task {
            try await operation()
        }
        startTask = task
        return try await task.value
    }
}

/*
 This must be initialized on a background queue to work correctly.

 "another important principle is to avoid passing NSManagedObject instances between contexts.
 This rule also applies to SwiftData.
 If you want to operate on the storage data corresponding to a PersistentModel in another
 ModelContext, you can solve it by passing the PersistentIdentifier of the object.
 PersistentIdentifier can be seen as the SwiftData implementation of NSManagedObjectId."
 */
@ModelActor
private actor DataHandler {
    func execute<T: Sendable>(
        block: @Sendable @escaping (ModelContext) throws -> T
    ) throws -> T {
        assert(!Thread.isMainThread)
        let result = try block(modelContext)

        if modelContext.hasChanges {
            try modelContext.save()
        }
        return result
    }
}
