//
//  Constants.swift
//  CloudeCode
//
//  Created by Ben Edelstein on 6/11/26.
//

import Foundation

enum Constants {
    /// Custom URL scheme registered by the active build configuration.
    static let deepLinkScheme: String = {
        guard let urlTypes = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]],
              let schemes = urlTypes.first?["CFBundleURLSchemes"] as? [String],
              let scheme = schemes.first,
              !scheme.isEmpty else {
            preconditionFailure("missing custom URL scheme in Info.plist")
        }
        return scheme
    }()

    /// OAuth callback handled by the app's registered custom URL scheme.
    static let oauthRedirectURI = "\(deepLinkScheme)://auth/callback"

    /// Web app origin injected by the active build scheme through Info.plist.
    static let webBaseURL: String = {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "WEB_BASE_URL") as? String,
              !value.isEmpty,
              URL(string: value) != nil else {
            preconditionFailure("missing or invalid WEB_BASE_URL in Info.plist")
        }
        return value.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }()

    /// Userdefaults keys
    enum UserDefaults {
        static let lastSelectedNewSessionModel = "lastSelectedNewSessionModel"
        static let lastSelectedNewSessionRepo = "lastSelectedNewSessionRepo"
        static let recentNewSessionRepos = "recentNewSessionRepos"
        /// Per-repo key prefix; append the repo id. Mirrors web's `lastEnvironmentId:{repoId}`.
        static let lastEnvironmentIdPrefix = "lastEnvironmentId:"
    }
}
