import Foundation

/// ISO 8601 timestamp transported verbatim as a string.
///
/// Timestamps stay strings on the wire types so decoding can never fail on a
/// format variant the platform date parser rejects (fractional seconds,
/// offsets). Convert at the display edge with `ISO8601.date(from:)`.
public typealias ISODateTimeString = String

public enum ISO8601 {
    nonisolated(unsafe) private static let standard: ISO8601DateFormatter = ISO8601DateFormatter()

    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// Parses an ISO 8601 timestamp with or without fractional seconds.
    public static func date(from string: ISODateTimeString) -> Date? {
        standard.date(from: string) ?? fractional.date(from: string)
    }
}
