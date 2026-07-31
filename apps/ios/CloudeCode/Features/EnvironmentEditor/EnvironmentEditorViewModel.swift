import API
import Domain
import Entities
import Foundation
import Observation

/// Observable state and mutation logic for native environment creation and editing.
@MainActor
@Observable
final class EnvironmentEditorViewModel {
    /// Whether the editor creates a new environment or edits an existing one.
    enum Mode: Equatable {
        case new(repoId: Int, repoFullName: String)
        case existing(environment: Domain.RepoEnvironment, repoFullName: String)
    }

    /// Network modes supported by this version of the editor.
    enum NetworkMode: String, CaseIterable, Identifiable {
        case locked
        case `default`
        case custom
        case open

        var id: String { rawValue }

        var label: String {
            switch self {
            case .locked: "No access"
            case .default: "Default"
            case .custom: "Custom"
            case .open: "Unrestricted"
            }
        }

        var description: String {
            switch self {
            case .locked:
                "Your agent cannot access the internet except through required inference and Git proxies."
            case .default:
                "Your agent can access the server-managed default allowlist for common development services."
            case .custom:
                "Only listed domains are allowed. You can also include the default allowlist."
            case .open:
                "Your agent has unrestricted internet access."
            }
        }
    }

    private let api: any RepoEnvironmentsAPIProviding
    private let environmentsStore: RepoEnvironmentsStore

    let mode: Mode
    let repoId: Int
    let repoFullName: String
    let unsupportedNetworkMode: String?

    var name: String
    var networkMode: NetworkMode
    var includeDefaultAllowlist: Bool
    var allowedDomainsText: String
    var plainEnvVarsText: String
    var startupScript: String
    private(set) var defaultAllowlistDomains: [String]?
    private(set) var isLoadingDefaultAllowlist: Bool = false
    private(set) var defaultAllowlistError: String?
    private(set) var isSaving: Bool = false
    var errorMessage: String?

    private struct InitialState {
        let repoId: Int
        let repoFullName: String
        let name: String
        let networkMode: NetworkMode
        let includeDefaultAllowlist: Bool
        let allowedDomainsText: String
        let plainEnvVarsText: String
        let startupScript: String
        let unsupportedNetworkMode: String?
    }

    private struct NetworkState {
        let mode: NetworkMode
        let includeDefaultAllowlist: Bool
        let allowedDomainsText: String
        let unsupportedMode: String?
    }

    var navigationTitle: String {
        switch mode {
        case .new: "New Environment"
        case .existing: "Edit Environment"
        }
    }

    var nameError: String? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedName.isEmpty {
            return "Name is required."
        }
        if trimmedName.count > 80 {
            return "Name must be 80 characters or fewer."
        }
        return nil
    }

    var allowedDomainsError: String? {
        guard networkMode == .custom else { return nil }
        return switch Self.parseAllowedDomains(allowedDomainsText) {
        case .success: nil
        case let .failure(error): error.errorDescription
        }
    }

    var plainEnvVarsError: String? {
        switch Self.parsePlainEnvVars(plainEnvVarsText) {
        case .success: nil
        case let .failure(error): error.errorDescription
        }
    }

    var startupScriptError: String? {
        startupScript.count > 20_000 ? "Startup script must be 20,000 characters or fewer." : nil
    }

    var canSubmit: Bool {
        !isSaving && unsupportedNetworkMode == nil && nameError == nil
            && allowedDomainsError == nil && plainEnvVarsError == nil
            && startupScriptError == nil
    }

    init(
        mode: Mode,
        api: any RepoEnvironmentsAPIProviding,
        environmentsStore: RepoEnvironmentsStore
    ) {
        self.mode = mode
        self.api = api
        self.environmentsStore = environmentsStore
        let initialState = Self.initialState(for: mode)
        repoId = initialState.repoId
        repoFullName = initialState.repoFullName
        name = initialState.name
        networkMode = initialState.networkMode
        includeDefaultAllowlist = initialState.includeDefaultAllowlist
        allowedDomainsText = initialState.allowedDomainsText
        plainEnvVarsText = initialState.plainEnvVarsText
        startupScript = initialState.startupScript
        unsupportedNetworkMode = initialState.unsupportedNetworkMode
    }

    /// Loads and retains the default allowlist for the native details sheet.
    func loadDefaultAllowlist() async {
        guard defaultAllowlistDomains == nil, !isLoadingDefaultAllowlist else { return }
        defaultAllowlistError = nil
        isLoadingDefaultAllowlist = true
        defer { isLoadingDefaultAllowlist = false }

        do {
            defaultAllowlistDomains = try await api.defaultNetworkAllowlist()
        } catch is CancellationError {
            return
        } catch {
            defaultAllowlistError = error.localizedDescription
        }
    }

    /// Submits valid form state once, updates memory immediately, and schedules persistence.
    func submit() async -> Domain.RepoEnvironment? {
        guard !isSaving, let input = makeInput() else {
            return nil
        }

        errorMessage = nil
        isSaving = true
        defer { isSaving = false }

        do {
            let environment: Domain.RepoEnvironment
            switch mode {
            case .new:
                environment = try await api.createEnvironment(repoId: repoId, input: input)
            case let .existing(existing, _):
                environment = try await api.updateEnvironment(
                    repoId: repoId,
                    environmentId: existing.id,
                    input: input
                )
            }
            environmentsStore.upsert(environment)
            return environment
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func makeInput() -> Domain.RepoEnvironment.Input? {
        let domainsResult = networkMode == .custom
            ? Self.parseAllowedDomains(allowedDomainsText)
            : .success([])
        guard canSubmit,
              case let .success(domains) = domainsResult,
              case let .success(plainEnvVars) = Self.parsePlainEnvVars(plainEnvVarsText) else {
            return nil
        }

        let network: Domain.RepoEnvironment.Network = switch networkMode {
        case .locked: .locked
        case .default: .default
        case .custom: .custom(
            extraAllowlist: domains,
            includeDefaultAllowlist: includeDefaultAllowlist
        )
        case .open: .open
        }
        let trimmedScript = startupScript.trimmingCharacters(in: .whitespacesAndNewlines)
        return Domain.RepoEnvironment.Input(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            network: network,
            plainEnvVars: plainEnvVars,
            startupScript: trimmedScript.isEmpty ? nil : trimmedScript
        )
    }
}

extension EnvironmentEditorViewModel {
    static func parseAllowedDomains(_ text: String) -> Result<[String], ValidationError> {
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ","))
        let domains = text.components(separatedBy: separators).filter { !$0.isEmpty }
        guard domains.count <= 100 else {
            return .failure(.tooManyDomains)
        }
        for domain in domains {
            guard domain.count <= 253,
                  domain.range(of: #"^\*?\.?[a-zA-Z0-9.-]+$"#, options: .regularExpression) != nil else {
                return .failure(.invalidDomain(domain))
            }
        }
        return .success(domains)
    }

    static func parsePlainEnvVars(_ text: String) -> Result<[String: String], ValidationError> {
        var variables: [String: String] = [:]
        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { continue }
            guard let separator = line.firstIndex(of: "="), separator != line.startIndex else {
                return .failure(.invalidVariableFormat)
            }
            let key = line[..<separator].trimmingCharacters(in: .whitespaces)
            guard key.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil else {
                return .failure(.invalidVariableName(String(key)))
            }
            let value = String(line[line.index(after: separator)...])
            guard value.count <= 5_000 else {
                return .failure(.variableValueTooLong(String(key)))
            }
            variables[String(key)] = value
        }
        return .success(variables)
    }

    private static func initialState(for mode: Mode) -> InitialState {
        switch mode {
        case let .new(repoId, repoFullName):
            InitialState(
                repoId: repoId,
                repoFullName: repoFullName,
                name: "",
                networkMode: .default,
                includeDefaultAllowlist: true,
                allowedDomainsText: "",
                plainEnvVarsText: "",
                startupScript: "",
                unsupportedNetworkMode: nil
            )
        case let .existing(environment, repoFullName):
            existingState(environment: environment, repoFullName: repoFullName)
        }
    }

    private static func existingState(
        environment: Domain.RepoEnvironment,
        repoFullName: String
    ) -> InitialState {
        let networkState = networkState(for: environment.network)
        return InitialState(
            repoId: environment.repoId,
            repoFullName: repoFullName,
            name: environment.name,
            networkMode: networkState.mode,
            includeDefaultAllowlist: networkState.includeDefaultAllowlist,
            allowedDomainsText: networkState.allowedDomainsText,
            plainEnvVarsText: environment.plainEnvVars
                .sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value)" }
                .joined(separator: "\n"),
            startupScript: environment.startupScript ?? "",
            unsupportedNetworkMode: networkState.unsupportedMode
        )
    }

    private static func networkState(
        for network: Domain.RepoEnvironment.Network
    ) -> NetworkState {
        switch network {
        case .locked:
            NetworkState(
                mode: .locked,
                includeDefaultAllowlist: true,
                allowedDomainsText: "",
                unsupportedMode: nil
            )
        case .default:
            NetworkState(
                mode: .default,
                includeDefaultAllowlist: true,
                allowedDomainsText: "",
                unsupportedMode: nil
            )
        case let .custom(domains, includeDefaults):
            NetworkState(
                mode: .custom,
                includeDefaultAllowlist: includeDefaults,
                allowedDomainsText: domains.joined(separator: "\n"),
                unsupportedMode: nil
            )
        case .open:
            NetworkState(
                mode: .open,
                includeDefaultAllowlist: true,
                allowedDomainsText: "",
                unsupportedMode: nil
            )
        case let .unknown(value):
            NetworkState(
                mode: .default,
                includeDefaultAllowlist: true,
                allowedDomainsText: "",
                unsupportedMode: value
            )
        }
    }
}

extension EnvironmentEditorViewModel {
    enum ValidationError: LocalizedError, Equatable {
        case tooManyDomains
        case invalidDomain(String)
        case invalidVariableFormat
        case invalidVariableName(String)
        case variableValueTooLong(String)

        var errorDescription: String? {
            switch self {
            case .tooManyDomains:
                "Enter no more than 100 allowed domains."
            case let .invalidDomain(domain):
                "Invalid domain \(domain). Use a hostname such as api.example.com or *.example.com."
            case .invalidVariableFormat:
                "Use KEY=value for environment variables."
            case let .invalidVariableName(name):
                "Invalid variable name \(name). Use a shell-compatible name such as API_KEY."
            case let .variableValueTooLong(name):
                "The value for \(name) must be 5,000 characters or fewer."
            }
        }
    }
}
