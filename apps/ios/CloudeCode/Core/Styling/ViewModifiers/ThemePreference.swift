import SwiftUI

/// User-selectable appearance. `system` follows the iOS setting; `light`/`dark`
/// force a fixed appearance. Persisted via `@AppStorage(AppStorageKey.themePreference)`.
enum ThemePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    /// Human-readable label for a future settings picker.
    var title: LocalizedStringKey {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    /// The color scheme to force, or `nil` to follow the system.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

/// Shared `@AppStorage` keys so writers (a future picker) and readers agree on the string.
enum AppStorageKey {
    static let themePreference: String = "themePreference"
}
