import Domain
import Foundation
import Valet

/// Bundle-scoped Valet for the native session. App-group Valet is kept only as
/// a migration fallback from the earlier storage location.
struct KeychainSessionPersistence: SessionPersisting {
    private let valet: Valet
    private let legacySharedGroupValet: Valet?

    /// - Parameters:
    ///   - bundleIdentifier: current app bundle id, e.g. `llc.bze.CloudeCode`.
    ///   - legacyAppGroup: previous app group storage id, e.g. `group.llc.bze.CloudeCode`.
    init(bundleIdentifier: String, legacyAppGroup: String) {
        guard let identifier = Identifier(nonEmpty: "\(bundleIdentifier).auth") else {
            preconditionFailure("invalid keychain identifier: \(bundleIdentifier)")
        }
        valet = Valet.valet(with: identifier, accessibility: .afterFirstUnlock)
        legacySharedGroupValet = Self.sharedGroupValet(appGroup: legacyAppGroup)
    }

    private static let key: String = "auth.session"

    func load() throws -> Session? {
        if let data = try loadData(from: valet) {
            return try JSONDecoder().decode(Session.self, from: data)
        }
        guard let legacySharedGroupValet, let data = try loadData(from: legacySharedGroupValet) else {
            return nil
        }
        let session = try JSONDecoder().decode(Session.self, from: data)
        try save(session)
        try? legacySharedGroupValet.removeObject(forKey: Self.key)
        return session
    }

    func save(_ session: Session) throws {
        try valet.setObject(JSONEncoder().encode(session), forKey: Self.key)
    }

    func clear() throws {
        try removeData(from: valet)
        if let legacySharedGroupValet {
            try? removeData(from: legacySharedGroupValet)
        }
    }

    private func loadData(from valet: Valet) throws -> Data? {
        do {
            return try valet.object(forKey: Self.key)
        } catch KeychainError.itemNotFound {
            return nil
        }
    }

    private func removeData(from valet: Valet) throws {
        do {
            try valet.removeObject(forKey: Self.key)
        } catch KeychainError.itemNotFound {
            return
        }
    }

    private static func sharedGroupValet(appGroup: String) -> Valet? {
        let group = appGroup.hasPrefix("group.")
            ? String(appGroup.dropFirst("group.".count))
            : appGroup
        guard let identifier = SharedGroupIdentifier(groupPrefix: "group", nonEmptyGroup: group) else {
            return nil
        }
        return Valet.sharedGroupValet(with: identifier, accessibility: .afterFirstUnlock)
    }
}
