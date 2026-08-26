@testable import API
import Domain
import Foundation
import Testing

@Suite("Provider auth API", .serialized)
struct ProviderAuthAPITests {
    @Test func claudeAuthorizationUsesAuthenticatedGet() async throws {
        let recorder = ProviderAuthRequestRecorder()
        let api = makeAPI(
            recorder: recorder,
            responseJSON: #"{"url":"https://claude.ai/oauth","state":"state-1"}"#
        )

        let authorization = try await api.claudeAuthorization()

        let request = try #require(recorder.request)
        #expect(request.httpMethod == "GET")
        #expect(request.url?.path == "/auth/claude")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
        #expect(authorization == ProviderAuthorization(url: "https://claude.ai/oauth", state: "state-1"))
    }

    @Test func claudeExchangeIncludesSessionRefreshTarget() async throws {
        let recorder = ProviderAuthRequestRecorder()
        let api = makeAPI(recorder: recorder, responseJSON: #"{"ok":true}"#)

        try await api.exchangeClaudeCode(
            code: "code-1",
            state: "state-1",
            sessionId: "session-1"
        )

        let request = try #require(recorder.request)
        let body = try #require(recorder.body)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/auth/claude/token")
        #expect(object == ["code": "code-1", "state": "state-1", "sessionId": "session-1"])
    }

    @Test func openAIDeviceStartMapsAuthorizationDetails() async throws {
        let recorder = ProviderAuthRequestRecorder()
        let api = makeAPI(
            recorder: recorder,
            responseJSON: #"""
            {
              "attemptId":"attempt-1",
              "verificationUrl":"https://openai.com/device",
              "userCode":"ABCD",
              "intervalSeconds":5,
              "expiresAt":"2026-07-17T12:00:00Z"
            }
            """#
        )

        let authorization = try await api.startOpenAIDeviceAuthorization()

        let request = try #require(recorder.request)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/auth/openai/device/start")
        #expect(authorization.attemptId == "attempt-1")
        #expect(authorization.verificationURL == "https://openai.com/device")
        #expect(authorization.userCode == "ABCD")
        #expect(authorization.intervalSeconds == 5)
    }

    @Test func openAIPollIncludesSessionAndMapsStatus() async throws {
        let recorder = ProviderAuthRequestRecorder()
        let api = makeAPI(recorder: recorder, responseJSON: #"{"status":"completed"}"#)

        let status = try await api.pollOpenAIDeviceAuthorization(
            attemptId: "attempt-1",
            sessionId: "session-2"
        )

        let request = try #require(recorder.request)
        #expect(request.httpMethod == "GET")
        #expect(request.url?.path == "/auth/openai/device/attempts/attempt-1")
        #expect(request.url?.query == "sessionId=session-2")
        #expect(status == .completed)
    }

    @Test func claudeDisconnectUsesAuthenticatedPost() async throws {
        let recorder = ProviderAuthRequestRecorder()
        let api = makeAPI(recorder: recorder, responseJSON: #"{"ok":true}"#)

        try await api.disconnectClaude()

        let request = try #require(recorder.request)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/auth/claude/disconnect")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
    }

    @Test func openAIDisconnectUsesAuthenticatedPost() async throws {
        let recorder = ProviderAuthRequestRecorder()
        let api = makeAPI(recorder: recorder, responseJSON: #"{"ok":true}"#)

        try await api.disconnectOpenAI()

        let request = try #require(recorder.request)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/auth/openai/disconnect")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
    }

    private func makeAPI(
        recorder: ProviderAuthRequestRecorder,
        responseJSON: String
    ) -> ProviderAuthAPI {
        guard let baseURL = URL(string: "https://api.example.com") else {
            preconditionFailure("invalid test base URL")
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProviderAuthURLProtocol.self]
        ProviderAuthURLProtocol.handler = { request in
            recorder.record(request, body: request.providerAuthBodyData)
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
        return ProviderAuthAPI(
            client: APIClient(
                baseURL: baseURL,
                urlSession: URLSession(configuration: configuration)
            ),
            tokenProvider: ProviderAuthTestTokenProvider()
        )
    }
}

private final class ProviderAuthRequestRecorder: @unchecked Sendable {
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
    var providerAuthBodyData: Data? {
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

private struct ProviderAuthTestTokenProvider: AuthTokenProviding {
    func authToken() async throws -> String? {
        "test-token"
    }
}

private final class ProviderAuthURLProtocol: URLProtocol, @unchecked Sendable {
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
