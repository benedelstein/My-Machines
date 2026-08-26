@testable import API
import Domain
import Foundation
import Testing

@Suite("Repo environments API", .serialized)
struct RepoEnvironmentsAPITests {
    @Test func defaultAllowlistUsesAuthenticatedGet() async throws {
        let recorder = RequestRecorder()
        let api = makeAPI(
            recorder: recorder,
            responseJSON: #"{"domains":["api.example.com","*.example.com"]}"#
        )

        let domains = try await api.defaultNetworkAllowlist()

        let request = try #require(recorder.request)
        #expect(request.httpMethod == "GET")
        #expect(request.url?.path == "/environments/default-allowlist")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
        #expect(domains == ["api.example.com", "*.example.com"])
    }

    @Test(arguments: [
        (Domain.RepoEnvironment.Network.locked, "locked"),
        (.default, "default"),
        (.custom(extraAllowlist: ["api.example.com"], includeDefaultAllowlist: true), "custom"),
        (.open, "open")
    ])
    func mutationBodyEncodesEveryNetworkMode(
        network: Domain.RepoEnvironment.Network,
        expectedMode: String
    ) throws {
        let body = RepoEnvironmentMutationBody(.init(
            name: "Development",
            network: network,
            plainEnvVars: ["API_URL": "https://example.com"],
            startupScript: "pnpm install"
        ))

        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        let networkObject = try #require(object["network"] as? [String: Any])
        #expect(networkObject["mode"] as? String == expectedMode)
        #expect(object["plainEnvVars"] as? [String: String] == ["API_URL": "https://example.com"])

        if expectedMode == "custom" {
            #expect(networkObject["extraAllowlist"] as? [String] == ["api.example.com"])
            #expect(networkObject["includeDefaultAllowlist"] as? Bool == true)
        }
    }

    @Test func mutationBodyEncodesExplicitNullStartupScript() throws {
        let body = RepoEnvironmentMutationBody(.init(
            name: "Development",
            network: .default,
            plainEnvVars: [:],
            startupScript: nil
        ))

        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(object.keys.contains("startupScript"))
        #expect(object["startupScript"] is NSNull)
    }

    @Test func createUsesAuthenticatedPostAndMapsFullResponse() async throws {
        let recorder = RequestRecorder()
        let api = makeAPI(recorder: recorder)

        let environment = try await api.createEnvironment(
            repoId: 42,
            input: .init(
                name: "Development",
                network: .custom(extraAllowlist: ["api.example.com"], includeDefaultAllowlist: false),
                plainEnvVars: ["API_URL": "https://example.com"],
                startupScript: "pnpm install"
            )
        )

        let request = try #require(recorder.request)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/repos/42/environments")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
        #expect(environment == expectedEnvironment)
    }

    @Test func updateUsesPatchAndSendsExplicitNullForClearedScript() async throws {
        let recorder = RequestRecorder()
        let api = makeAPI(recorder: recorder)

        let environment = try await api.updateEnvironment(
            repoId: 42,
            environmentId: "environment-id",
            input: .init(
                name: "Development",
                network: .locked,
                plainEnvVars: [:],
                startupScript: nil
            )
        )

        let request = try #require(recorder.request)
        let body = try #require(recorder.body)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(request.httpMethod == "PATCH")
        #expect(request.url?.path == "/repos/42/environments/environment-id")
        #expect(object.keys.contains("startupScript"))
        #expect(object["startupScript"] is NSNull)
        #expect(environment == expectedEnvironment)
    }

    private var expectedEnvironment: Domain.RepoEnvironment {
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

    private func makeAPI(
        recorder: RequestRecorder,
        responseJSON: String = Self.responseJSON
    ) -> RepoEnvironmentsAPI {
        guard let baseURL = URL(string: "https://api.example.com") else {
            preconditionFailure("invalid test base URL")
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EnvironmentURLProtocol.self]
        EnvironmentURLProtocol.handler = { request in
            recorder.record(request, body: request.bodyData)
            guard let url = request.url,
                  let response = HTTPURLResponse(
                      url: url,
                      statusCode: 200,
                      httpVersion: nil,
                      headerFields: ["Content-Type": "application/json"]
                  ) else {
                preconditionFailure("failed to create test response")
            }
            return (response, Data(responseJSON.utf8))
        }
        return RepoEnvironmentsAPI(
            client: APIClient(
                baseURL: baseURL,
                urlSession: URLSession(configuration: configuration)
            ),
            tokenProvider: TestTokenProvider()
        )
    }

    private static let responseJSON: String = #"""
    {
      "environment": {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "repoId": 42,
        "name": "Development",
        "network": {
          "mode": "custom",
          "extraAllowlist": ["api.example.com"],
          "includeDefaultAllowlist": true
        },
        "plainEnvVars": {"API_URL": "https://example.com"},
        "startupScript": "pnpm install",
        "createdAt": "2026-07-13T12:00:00.000Z",
        "updatedAt": "2026-07-13T13:00:00.000Z"
      }
    }
    """#
}

private final class RequestRecorder: @unchecked Sendable {
    private let lock: NSLock = .init()
    private var storedRequest: URLRequest?
    private var storedBody: Data?

    var request: URLRequest? {
        lock.withLock { storedRequest }
    }

    var body: Data? {
        lock.withLock { storedBody }
    }

    func record(_ request: URLRequest, body: Data?) {
        lock.withLock {
            storedRequest = request
            storedBody = body
        }
    }
}

private extension URLRequest {
    var bodyData: Data? {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return nil }

        stream.open()
        defer { stream.close() }
        var data = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1_024)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: 1_024)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private struct TestTokenProvider: AuthTokenProviding {
    func authToken() async throws -> String? {
        "test-token"
    }
}

private final class EnvironmentURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (HTTPURLResponse, Data))?

    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else { return }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
