import Foundation

/// A stable identity derived from a node's position in the complete Markdown source.
public struct MarkdownSourceID: Sendable, Hashable {
    /// The node's absolute UTF-16 source offset.
    public let utf16SourceOffset: Int

    /// The ordinal among siblings that begin at the same source offset.
    public let siblingOrdinal: Int

    init(utf16SourceOffset: Int, siblingOrdinal: Int = 0) {
        self.utf16SourceOffset = utf16SourceOffset
        self.siblingOrdinal = siblingOrdinal
    }
}

/// A render-ready snapshot of a Markdown document.
public struct MarkdownRenderSnapshot: Sendable, Hashable {
    /// The parsing strategy currently used by the document.
    public enum Mode: Sendable, Hashable {
        /// Only the mutable tail is reparsed.
        case incrementalTail

        /// The complete source is reparsed to resolve document-wide references.
        case wholeDocument
    }

    /// Ordered render parts whose source slices reconstruct the complete input.
    public let parts: [MarkdownPart]

    /// The parsing strategy used to build this snapshot.
    public let mode: Mode

    init(parts: [MarkdownPart], mode: Mode) {
        self.parts = parts
        self.mode = mode
    }
}

/// A top-level cache and render unit in a Markdown document.
public struct MarkdownPart: Identifiable, Sendable, Hashable {
    /// Whether a part can still change as source is appended.
    public enum Stability: Sendable, Hashable {
        /// The source and rendered value will not be rebuilt.
        case finalized

        /// More appended source may change this part.
        case active
    }

    /// How the part joins the content before it.
    public enum LeadingBoundary: Sendable, Hashable {
        /// The part begins at a Markdown block boundary.
        case block

        /// The part continues prose split within a physical source line.
        case proseContinuation
    }

    /// The source-derived stable identity.
    public let id: MarkdownSourceID

    /// The exact source slice represented by this part.
    public let source: String

    /// The semantic block rendered by the app.
    public let block: MarkdownBlock

    /// Whether this part is immutable or still active.
    public let stability: Stability

    /// How spacing should be applied before this part.
    public let leadingBoundary: LeadingBoundary

    init(
        id: MarkdownSourceID,
        source: String,
        block: MarkdownBlock,
        stability: Stability,
        leadingBoundary: LeadingBoundary = .block
    ) {
        self.id = id
        self.source = source
        self.block = block
        self.stability = stability
        self.leadingBoundary = leadingBoundary
    }
}

/// A recursive semantic Markdown block independent of the parser AST.
public struct MarkdownBlock: Identifiable, Sendable, Hashable {
    /// Supported render content for a Markdown block.
    public indirect enum Content: Sendable, Hashable {
        /// One or more consecutive prose paragraphs.
        case prose(paragraphs: [MarkdownParagraph])

        /// A heading and its inline content.
        case heading(level: Int, content: AttributedString)

        /// An unordered list.
        case unorderedList(items: [MarkdownListItem])

        /// An ordered list and its source start number.
        case orderedList(startIndex: UInt, items: [MarkdownListItem])

        /// A block quote containing recursive blocks.
        case blockQuote(blocks: [MarkdownBlock])

        /// A thematic divider.
        case thematicBreak

        /// A fenced or indented code block.
        case codeBlock(MarkdownCodeBlock)

        /// A GitHub-flavored Markdown table.
        case table(MarkdownTable)

        /// Preserved source for a syntax intentionally rendered literally.
        case literal(String)

        /// Source that contributes no visible Markdown block, such as a reference definition.
        case sourceOnly
    }

    /// The source-derived stable identity.
    public let id: MarkdownSourceID

    /// The semantic block content.
    public let content: Content

    init(id: MarkdownSourceID, content: Content) {
        self.id = id
        self.content = content
    }
}

/// One inline-styled paragraph inside a prose block.
public struct MarkdownParagraph: Identifiable, Sendable, Hashable {
    /// The source-derived stable identity.
    public let id: MarkdownSourceID

    /// Inline content ready for SwiftUI `Text`.
    public let content: AttributedString

    init(id: MarkdownSourceID, content: AttributedString) {
        self.id = id
        self.content = content
    }
}

/// One recursive item inside an ordered or unordered list.
public struct MarkdownListItem: Identifiable, Sendable, Hashable {
    /// Task-list state parsed from the item marker.
    public enum Checkbox: Sendable, Hashable {
        /// The task is checked.
        case checked

        /// The task is unchecked.
        case unchecked
    }

    /// The source-derived stable identity.
    public let id: MarkdownSourceID

    /// Optional task-list state.
    public let checkbox: Checkbox?

    /// Recursive blocks in the list item.
    public let blocks: [MarkdownBlock]

    init(id: MarkdownSourceID, checkbox: Checkbox?, blocks: [MarkdownBlock]) {
        self.id = id
        self.checkbox = checkbox
        self.blocks = blocks
    }
}

/// Render content for a GitHub-flavored Markdown table.
public struct MarkdownTable: Sendable, Hashable {
    /// Horizontal alignment applied to every cell in a column.
    public enum ColumnAlignment: Sendable, Hashable {
        /// Cells align to the leading edge.
        case leading

        /// Cells align to the column center.
        case center

        /// Cells align to the trailing edge.
        case trailing
    }

    /// One table cell and the number of columns it covers.
    public struct Cell: Sendable, Hashable {
        /// Inline content ready for SwiftUI `Text`.
        public let content: AttributedString

        /// The number of columns this cell covers, at least one.
        public let columnSpan: Int

        init(content: AttributedString, columnSpan: Int) {
            self.content = content
            self.columnSpan = max(1, columnSpan)
        }
    }

    /// One header or body row.
    public struct Row: Sendable, Hashable {
        /// The cells in source order, excluding cells covered by a spanning neighbor.
        public let cells: [Cell]

        init(cells: [Cell]) {
            self.cells = cells
        }
    }

    /// Per-column alignment in column order; `nil` entries use the default alignment.
    public let columnAlignments: [ColumnAlignment?]

    /// The header row, or `nil` when the table declares no header cells.
    public let header: Row?

    /// The body rows.
    public let rows: [Row]

    init(columnAlignments: [ColumnAlignment?], header: Row?, rows: [Row]) {
        self.columnAlignments = columnAlignments
        self.header = header
        self.rows = rows
    }

    /// The widest row's total column span.
    public var columnCount: Int {
        let allRows = (header.map { [$0] } ?? []) + rows
        return allRows.map { row in row.cells.reduce(0) { $0 + $1.columnSpan } }.max() ?? 0
    }

    /// Returns the alignment for a column, defaulting to leading.
    ///
    /// - Parameter index: The zero-based column index.
    /// - Returns: The declared alignment, or leading when the column declares none.
    public func alignment(forColumn index: Int) -> ColumnAlignment {
        guard index >= 0, index < columnAlignments.count else {
            return .leading
        }
        return columnAlignments[index] ?? .leading
    }
}

/// Render content for a fenced or indented code block.
public struct MarkdownCodeBlock: Sendable, Hashable {
    /// The code without fence markers.
    public let code: String

    /// The optional fenced-code info string language.
    public let language: String?

    init(code: String, language: String?) {
        self.code = code
        self.language = language
    }
}
