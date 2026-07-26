import SwiftData

public enum SchemaV1: VersionedSchema {
    // fixed at declaration time. if you need a new version,
    // create a new VersionedSchema
    public static let versionIdentifier = Schema.Version(1, 0, 0)

    public static var models: [any PersistentModel.Type] {
        // Note - adding a new model does not require a new versioned schema.
        [
            UserEntity.self,
            SessionSummaryEntity.self,
            SessionMessageEntity.self,
            RepoEnvironmentEntity.self,
            SessionClientStateEntity.self
        ]
    }

    public static var entities: [any Entity.Type] {
        models.compactMap { model in
            guard let entity = model as? any Entity.Type else {
                assertionFailure("\(model) must conform to Entity to be registered in the cache schema.")
                return nil
            }
            return entity
        }
    }
}

public typealias CurrentSchema = SchemaV1

public enum MigrationPlan: SchemaMigrationPlan {
    public static var schemas: [any VersionedSchema.Type] {
        [SchemaV1.self]
    }

    // Add a MigrationStage per schema bump (e.g. .lightweight(fromVersion:toVersion:)).
    public static var stages: [MigrationStage] {
        []
    }
}

public struct ModelContainerFactory: Sendable {
    public init() {}

    public func make(inMemory: Bool = false) throws -> ModelContainer {
        let schema = Schema(versionedSchema: CurrentSchema.self)
        let configuration = ModelConfiguration(
            "CloudeCode",
            schema: schema,
            isStoredInMemoryOnly: inMemory,
            allowsSave: true,
            // Cache lives in the app sandbox. An app group container is only
            // needed if extensions/widgets ever read this store — switch to
            // .identifier(appGroup) then.
            groupContainer: .none,
            cloudKitDatabase: .none
        )

        return try ModelContainer(
            for: schema,
            migrationPlan: MigrationPlan.self,
            configurations: [configuration]
        )
    }
}
