@testable import API
import Foundation
import Testing

@Suite("Auth API", .serialized)
struct AuthAPITests {
    @Test func signInCompletionSendsBothAttemptSecrets() async throws {
        let recorder = AuthRequestRecorder()
        let api = makeUnauthenticatedAPI(recorder: recorder)

        _ = try await api.completeSignIn(
            attemptId: "attempt-1",
            claimToken: "claim-1",
            completionCode: "completion-1"
        )

        let request = try #require(recorder.request)
        let body = try requestBody(request)
        let json = try #require(
            JSONSerialization.jsonObject(with: body) as? [String: String]
        )
        #expect(json["attemptId"] == "attempt-1")
        #expect(json["claimToken"] == "claim-1")
        #expect(json["completionCode"] == "completion-1")
    }

    @Test func installationStartUsesAuthenticatedPostAndMapsPage() async throws {
        let recorder = AuthRequestRecorder()
        let api = makeAPI(recorder: recorder)

        let page = try await api.githubInstallationPage(
            redirectUri: "cloudecode-dev://auth/callback"
        )

        let request = try #require(recorder.request)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/auth/github/install/start")
        #expect(request.url?.query == "redirectUri=cloudecode-dev://auth/callback")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
        #expect(page.state == "install-state")
        #expect(page.url.absoluteString == "https://github.test/install?state=install-state")
    }

    private func makeAPI(recorder: AuthRequestRecorder) -> AuthAPI {
        guard let baseURL = URL(string: "https://api.example.com") else {
            preconditionFailure("invalid test base URL")
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AuthURLProtocol.self]
        AuthURLProtocol.handler = { request in
            recorder.record(request)
            guard let url = request.url,
                  let response = HTTPURLResponse(
                      url: url,
                      statusCode: 200,
                      httpVersion: nil,
                      headerFields: ["Content-Type": "application/json"]
                  ) else {
                preconditionFailure("failed to create test response")
            }
            let json = #"{"url":"https://github.test/install?state=install-state","state":"install-state"}"#
            return (response, Data(json.utf8))
        }
        return AuthAPI(
            client: APIClient(
                baseURL: baseURL,
                urlSession: URLSession(configuration: configuration)
            ),
            tokenProvider: AuthTestTokenProvider()
        )
    }

    private func makeUnauthenticatedAPI(
        recorder: AuthRequestRecorder
    ) -> UnauthenticatedAuthAPI {
        let payload = Data(#"{"sub":"user-1","exp":2000000000}"#.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let accessToken = "header.\(payload).signature"
        let response = """
        {
          "accessToken": "\(accessToken)",
          "refreshToken": "refresh-1",
          "refreshTokenExpiresAt": "2030-01-01T00:00:00.000Z",
          "user": {
            "id": "user-1",
            "login": "octocat",
            "name": null,
            "avatarUrl": null
          }
        }
        """
        return UnauthenticatedAuthAPI(client: makeClient(
            recorder: recorder,
            response: response
        ))
    }

    private func makeClient(
        recorder: AuthRequestRecorder,
        response: String
    ) -> APIClient {
        guard let baseURL = URL(string: "https://api.example.com") else {
            preconditionFailure("invalid test base URL")
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AuthURLProtocol.self]
        AuthURLProtocol.handler = { request in
            recorder.record(request)
            guard let url = request.url,
                  let httpResponse = HTTPURLResponse(
                      url: url,
                      statusCode: 200,
                      httpVersion: nil,
                      headerFields: ["Content-Type": "application/json"]
                  ) else {
                preconditionFailure("failed to create test response")
            }
            return (httpResponse, Data(response.utf8))
        }
        return APIClient(baseURL: baseURL, urlSession: URLSession(configuration: configuration))
    }

    private func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody {
            return body
        }
        let stream = try #require(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class AuthRequestRecorder: @unchecked Sendable {
    private let lock: NSLock = .init()
    private var storedRequest: URLRequest?

    var request: URLRequest? {
        lock.withLock { storedRequest }
    }

    func record(_ request: URLRequest) {
        lock.withLock {
            storedRequest = request
        }
    }
}

private struct AuthTestTokenProvider: AuthTokenProviding {
    func authToken() async throws -> String? {
        "test-token"
    }
}

private final class AuthURLProtocol: URLProtocol, @unchecked Sendable {
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
