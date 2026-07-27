/// A page of values returned by a cursor-paginated API.
///
/// The cursor belongs to the returned values and should be passed back to the
/// same endpoint to request the following page.
public struct CursorPage<Value> {
    public let values: [Value]
    public let nextCursor: String?

    /// Creates a cursor page.
    ///
    /// - Parameters:
    ///   - values: Values returned for this page.
    ///   - nextCursor: Cursor for the following page, or `nil` at the end.
    public init(values: [Value], nextCursor: String?) {
        self.values = values
        self.nextCursor = nextCursor
    }

    /// Whether the endpoint reports another page.
    public var hasNextPage: Bool {
        nextCursor != nil
    }

    /// Returns a page containing this page followed by another page.
    ///
    /// The resulting cursor is always the appended page's cursor.
    public func appending(_ page: CursorPage<Value>) -> CursorPage<Value> {
        CursorPage(
            values: values + page.values,
            nextCursor: page.nextCursor
        )
    }

    /// Transforms the page values while preserving its cursor.
    public func map<TransformedValue>(
        _ transform: (Value) throws -> TransformedValue
    ) rethrows -> CursorPage<TransformedValue> {
        try CursorPage<TransformedValue>(
            values: values.map(transform),
            nextCursor: nextCursor
        )
    }
}

extension CursorPage: Equatable where Value: Equatable {}
extension CursorPage: Hashable where Value: Hashable {}
extension CursorPage: Sendable where Value: Sendable {}
