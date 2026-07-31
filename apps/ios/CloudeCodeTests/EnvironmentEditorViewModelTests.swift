import API
@testable import CloudeCode
import Domain
import Entities
import Foundation
import Testing

@Suite("Environment editor view model", .serialized)
@MainActor
struct EnvironmentEditorViewModelTests {
    @Test func newModeStartsWithWebDefaults() {
        let viewModel = makeViewModel(mode: .new(repoId: 42, repoFullName: "owner/repo"))

        #expect(viewModel.repoId == 42)
        #expect(viewModel.repoFullName == "owner/repo")
        #expect(viewModel.name.isEmpty)
        #expect(viewModel.networkMode == .default)
        #expect(viewModel.includeDefaultAllowlist)
        #expect(viewModel.allowedDomainsText.isEmpty)
        #expect(viewModel.plainEnvVarsText.isEmpty)
        #expect(viewModel.startupScript.isEmpty)
    }

    @Test func existingModePopulatesEveryEditableField() {
        let environment = makeEnvironment()
        let viewModel = makeViewModel(
            mode: .existing(environment: environment, repoFullName: "owner/repo")
        )

        #expect(viewModel.name == "Development")
        #expect(viewModel.networkMode == .custom)
        #expect(viewModel.includeDefaultAllowlist)
        #expect(viewModel.allowedDomainsText == "api.example.com")
        #expect(viewModel.plainEnvVarsText == "API_URL=https://example.com")
        #expect(viewModel.startupScript == "pnpm install")
    }

    @Test func parsersMatchServerValidation() throws {
        let domains = try EnvironmentEditorViewModel.parseAllowedDomains(
            "api.example.com, *.example.com\n.internal"
        ).get()
        let variables = try EnvironmentEditorViewModel.parsePlainEnvVars(
            "API_URL=https://example.com?a=b\n_COUNT=2"
        ).get()

        #expect(domains == ["api.example.com", "*.example.com", ".internal"])
        #expect(variables == [
            "API_URL": "https://example.com?a=b",
            "_COUNT": "2"
        ])
        #expect(EnvironmentEditorViewModel.parseAllowedDomains("https://example.com").isFailure)
        #expect(EnvironmentEditorViewModel.parsePlainEnvVars("BAD KEY=value").isFailure)
        #expect(EnvironmentEditorViewModel.parsePlainEnvVars("KEY").isFailure)
        #expect(EnvironmentEditorViewModel.parsePlainEnvVars("KEY=\(String(repeating: "x", count: 5_001))").isFailure)
    }

    @Test func requiredNameAndRuntimeLimitsDisableSubmit() {
        let viewModel = makeViewModel(mode: .new(repoId: 42, repoFullName: "owner/repo"))

        #expect(!viewModel.canSubmit)
        #expect(viewModel.nameError != nil)

        viewModel.name = "Development"
        viewModel.startupScript = String(repeating: "x", count: 20_001)
        #expect(!viewModel.canSubmit)
        #expect(viewModel.startupScriptError != nil)

        viewModel.startupScript = "echo ready"
        #expect(viewModel.canSubmit)
    }

    @Test func defaultAllowlistLoadsOnceAndStaysInMemory() async {
        let api = FakeRepoEnvironmentsAPI(environment: makeEnvironment())
        let viewModel = makeViewModel(
            mode: .new(repoId: 42, repoFullName: "owner/repo"),
            api: api
        )

        await viewModel.loadDefaultAllowlist()
        await viewModel.loadDefaultAllowlist()

        #expect(viewModel.defaultAllowlistDomains == ["api.example.com", "*.example.com"])
        #expect(viewModel.defaultAllowlistError == nil)
        #expect(await api.defaultAllowlistRequestCount == 1)
    }

    @Test func defaultAllowlistFailureCanBeRetried() async {
        let api = FakeRepoEnvironmentsAPI(environment: makeEnvironment(), shouldFail: true)
        let viewModel = makeViewModel(
            mode: .new(repoId: 42, repoFullName: "owner/repo"),
            api: api
        )

        await viewModel.loadDefaultAllowlist()
        await viewModel.loadDefaultAllowlist()

        #expect(viewModel.defaultAllowlistDomains == nil)
        #expect(viewModel.defaultAllowlistError != nil)
        #expect(await api.defaultAllowlistRequestCount == 2)
    }

    @Test func domainsAreIgnoredOutsideCustomNetworkMode() async throws {
        let api = FakeRepoEnvironmentsAPI(environment: makeEnvironment())
        let viewModel = makeViewModel(
            mode: .new(repoId: 42, repoFullName: "owner/repo"),
            api: api
        )
        viewModel.name = "Development"
        viewModel.allowedDomainsText = "https://invalid.example.com"
        viewModel.networkMode = .default

        _ = await viewModel.submit()

        let input = try #require(await api.createdInput)
        #expect(input.network == .default)
    }

    @Test func createTrimsInputUpsertsStoreAndReturnsCanonicalEnvironment() async throws {
        let environment = makeEnvironment()
        let api = FakeRepoEnvironmentsAPI(environment: environment)
        let store = RepoEnvironmentsStore { _ in [] }
        let viewModel = EnvironmentEditorViewModel(
            mode: .new(repoId: 42, repoFullName: "owner/repo"),
            api: api,
            environmentsStore: store
        )
        viewModel.name = "  Development  "
        viewModel.networkMode = .custom
        viewModel.allowedDomainsText = "api.example.com"
        viewModel.includeDefaultAllowlist = true
        viewModel.plainEnvVarsText = "API_URL=https://example.com"
        viewModel.startupScript = "  pnpm install  "

        let result = await viewModel.submit()

        #expect(result == environment)
        #expect(store.environments(repoId: 42) == [environment])
        let input = try #require(await api.createdInput)
        #expect(input.name == "Development")
        #expect(input.startupScript == "pnpm install")
        #expect(input.network == .custom(
            extraAllowlist: ["api.example.com"],
            includeDefaultAllowlist: true
        ))
    }

    @Test func editUsesExistingIdAndClearsBlankStartupScript() async throws {
        let environment = makeEnvironment()
        let api = FakeRepoEnvironmentsAPI(environment: environment)
        let viewModel = makeViewModel(
            mode: .existing(environment: environment, repoFullName: "owner/repo"),
            api: api
        )
        viewModel.startupScript = "  \n"

        _ = await viewModel.submit()

        #expect(await api.updatedEnvironmentId == environment.id)
        #expect(await api.updatedInput?.startupScript == nil)
    }

    @Test func duplicateSubmitIsIgnoredWhileSaving() async {
        let api = FakeRepoEnvironmentsAPI(environment: makeEnvironment(), delayNanoseconds: 100_000_000)
        let viewModel = makeViewModel(mode: .new(repoId: 42, repoFullName: "owner/repo"), api: api)
        viewModel.name = "Development"

        let first = Task { await viewModel.submit() }
        await Task.yield()
        let second = await viewModel.submit()
        _ = await first.value

        #expect(second == nil)
        #expect(await api.createCount == 1)
    }

    @Test func APIErrorIsPresentedWithoutUpdatingStore() async {
        let api = FakeRepoEnvironmentsAPI(environment: makeEnvironment(), shouldFail: true)
        let store = RepoEnvironmentsStore { _ in [] }
        let viewModel = EnvironmentEditorViewModel(
            mode: .new(repoId: 42, repoFullName: "owner/repo"),
            api: api,
            environmentsStore: store
        )
        viewModel.name = "Development"

        let result = await viewModel.submit()

        #expect(result == nil)
        #expect(viewModel.errorMessage != nil)
        #expect(store.environments(repoId: 42) == nil)
    }

    private func makeViewModel(
        mode: EnvironmentEditorViewModel.Mode,
        api: FakeRepoEnvironmentsAPI? = nil
    ) -> EnvironmentEditorViewModel {
        EnvironmentEditorViewModel(
            mode: mode,
            api: api ?? FakeRepoEnvironmentsAPI(environment: makeEnvironment()),
            environmentsStore: RepoEnvironmentsStore { _ in [] }
        )
    }

    private func makeEnvironment() -> Domain.RepoEnvironment {
        Domain.RepoEnvironment(
            id: "123e4567-e89b-12d3-a456-426614174000",
            repoId: 42,
            name: "Development",
            network: .custom(extraAllowlist: ["api.example.com"], includeDefaultAllowlist: true),
            plainEnvVars: ["API_URL": "https://example.com"],
            startupScript: "pnpm install",
            createdAt: "2026-07-13T12:00:00.000Z",
            updatedAt: "2026-07-13T13:00:00.000Z"
        )
    }
}

private actor FakeRepoEnvironmentsAPI: RepoEnvironmentsAPIProviding {
    let environment: Domain.RepoEnvironment
    let delayNanoseconds: UInt64
    let shouldFail: Bool
    private(set) var createCount: Int = 0
    private(set) var defaultAllowlistRequestCount: Int = 0
    private(set) var createdInput: Domain.RepoEnvironment.Input?
    private(set) var updatedEnvironmentId: String?
    private(set) var updatedInput: Domain.RepoEnvironment.Input?

    init(
        environment: Domain.RepoEnvironment,
        delayNanoseconds: UInt64 = 0,
        shouldFail: Bool = false
    ) {
        self.environment = environment
        self.delayNanoseconds = delayNanoseconds
        self.shouldFail = shouldFail
    }

    func listEnvironments(repoId: Int) async throws -> [Domain.RepoEnvironment] {
        [environment]
    }

    func defaultNetworkAllowlist() async throws -> [String] {
        defaultAllowlistRequestCount += 1
        if shouldFail { throw EditorTestError.failed }
        return ["api.example.com", "*.example.com"]
    }

    func createEnvironment(
        repoId: Int,
        input: Domain.RepoEnvironment.Input
    ) async throws -> Domain.RepoEnvironment {
        createCount += 1
        createdInput = input
        if delayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: delayNanoseconds)
        }
        if shouldFail { throw EditorTestError.failed }
        return environment
    }

    func updateEnvironment(
        repoId: Int,
        environmentId: String,
        input: Domain.RepoEnvironment.Input
    ) async throws -> Domain.RepoEnvironment {
        updatedEnvironmentId = environmentId
        updatedInput = input
        if shouldFail { throw EditorTestError.failed }
        return environment
    }
}

private enum EditorTestError: Error {
    case failed
}

private extension Result {
    var isFailure: Bool {
        if case .failure = self { return true }
        return false
    }
}
