import SwiftUI

/// Semantic color tokens. Views read the active theme from the environment
/// (`@Environment(\.theme)`) instead of referencing raw colors directly.
/// Pick a concrete variant with `Theme.light` / `Theme.dark`.
struct Theme {
    // MARK: Backgrounds
    var backgroundColor: Color = .white
    var secondaryBackgroundColor: Color = Color(hex: 0xF4F4F4)
    var tertiaryBackgroundColor: Color = Color(hex: 0xF0F0F0)
    var highlightColor: Color = Color(hex: 0xF0F0F0)
    /// Disabled button background
    var disabledBackgroundColor: Color = Color(hex: 0xC8C8C8)
    var loadingBackgroundColor: Color = Color(hex: 0xE8E8E8)
    var sliderBackgroundColor: Color = Color(hex: 0xD9D9D9)

    // MARK: Labels
    var labelColor: Color = .black
    var secondaryLabelColor: Color = Color(hex: 0x7E7E7E)
    var tertiaryLabelColor: Color = Color(hex: 0xA8A8A8)

    // MARK: Outlines
    var outlineColor: Color = Color(hex: 0xB2B2B2)

    // MARK: Accents
    var accentBlue: Color = Color(hex: 0x12B8FF)
    var accentOrange: Color = Color(hex: 0xFF5101)
    var green: Color = Color(hex: 0x1FE053)
    var errorRed: Color = Color(hex: 0xF51A12)
}

extension Theme {
    /// Light appearance — the default palette above.
    static let light: Theme = Theme()

    /// Dark appearance — dark backgrounds, light labels, accents nudged for contrast.
    static let dark: Theme = Theme(
        backgroundColor: Color(hex: 0x090A0B),
        secondaryBackgroundColor: Color(hex: 0x19191B),
        tertiaryBackgroundColor: Color(hex: 0x28282A).opacity(0.5),
        highlightColor: Color(hex: 0x2A2A2C),
        disabledBackgroundColor: Color(hex: 0x3A3A3C),
        loadingBackgroundColor: Color(hex: 0x2C2C2E),
        sliderBackgroundColor: Color(hex: 0x48484A),
        labelColor: .white,
        secondaryLabelColor: Color(hex: 0x9A9A9F),
        tertiaryLabelColor: Color(hex: 0x7F7F88),
        outlineColor: Color(hex: 0x3A3A3C),
        accentBlue: Color(hex: 0x39C6FF),
        accentOrange: Color(hex: 0xFF6A2C),
        green: Color(hex: 0x33E866),
        errorRed: Color(hex: 0xFF453A)
    )

    /// Resolves the matching variant for a SwiftUI color scheme.
    static func resolve(for colorScheme: ColorScheme) -> Theme {
        switch colorScheme {
        case .dark:
                .dark
        case .light:
                .light
        @unknown default:
                .light
        }
    }
}

extension EnvironmentValues {
    @Entry
    var theme: Theme = .light
}
