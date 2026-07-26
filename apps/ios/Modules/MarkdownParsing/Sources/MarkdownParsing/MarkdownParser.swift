import Foundation
import Markdown

struct ParsedMarkdown {
    struct TopLevelBlock {
        enum Kind {
            case paragraph(MarkdownParagraph)
            case semantic
        }

        let absoluteSourceRange: Range<Int>
        let syntaxSourceRange: Range<Int>
        let startLine: Int
        let endLine: Int
        let kind: Kind
        let block: MarkdownBlock
    }

    let blocks: [TopLevelBlock]
    let codeRanges: [Range<Int>]
}

protocol MarkdownParserProtocol: Sendable {
    func parse(source: String, absoluteUTF16Offset: Int) -> ParsedMarkdown
}

struct SwiftMarkdownParser: MarkdownParserProtocol {
    func parse(source: String, absoluteUTF16Offset: Int) -> ParsedMarkdown {
        parseMarkdown(source: source, absoluteUTF16Offset: absoluteUTF16Offset)
    }
}

struct MarkdownSourceMap {
    let source: String
    let absoluteUTF16Offset: Int
    private let lines: [(utf16Offset: Int, text: String)]

    init(source: String, absoluteUTF16Offset: Int) {
        self.source = source
        self.absoluteUTF16Offset = absoluteUTF16Offset

        let utf16Source = source as NSString
        var parsedLines: [(Int, String)] = []
        var lineStart = 0
        while lineStart <= utf16Source.length {
            let remaining = NSRange(location: lineStart, length: utf16Source.length - lineStart)
            let lineFeed = utf16Source.range(of: "\n", options: [], range: remaining)
            let lineEnd = lineFeed.location == NSNotFound ? utf16Source.length : lineFeed.location
            parsedLines.append((lineStart, utf16Source.substring(with: NSRange(
                location: lineStart,
                length: lineEnd - lineStart
            ))))
            guard lineFeed.location != NSNotFound else {
                break
            }
            lineStart = lineFeed.location + lineFeed.length
        }
        lines = parsedLines
    }

    func absoluteUTF16Offset(for location: SourceLocation) -> Int? {
        guard location.line > 0, location.line <= lines.count, location.column > 0 else {
            return nil
        }
        let line = lines[location.line - 1]
        let byteOffset = location.column - 1
        guard byteOffset <= line.text.utf8.count else {
            return nil
        }
        let prefix = String(decoding: line.text.utf8.prefix(byteOffset), as: UTF8.self)
        let localOffset = prefix.utf16.count
        return absoluteUTF16Offset + line.utf16Offset + localOffset
    }

    func absoluteRange(for range: SourceRange) -> Range<Int>? {
        let lower = absoluteUTF16Offset(for: range.lowerBound)
        let upper = absoluteUTF16Offset(for: range.upperBound)
        guard let lowerBound = lower,
              let upperBound = upper,
              lowerBound <= upperBound else {
            return nil
        }
        return lowerBound..<upperBound
    }

    func source(inAbsoluteRange range: Range<Int>) -> String {
        let localRange = (range.lowerBound - absoluteUTF16Offset)..<(range.upperBound - absoluteUTF16Offset)
        return source.substring(utf16Offsets: localRange)
    }

}

func parseMarkdown(source: String, absoluteUTF16Offset: Int) -> ParsedMarkdown {
    let document = Document(parsing: source, options: [.disableSmartOpts])
    let sourceMap = MarkdownSourceMap(source: source, absoluteUTF16Offset: absoluteUTF16Offset)
    let nodes = Array(document.children)
    var syntaxRanges: [Range<Int>] = []
    syntaxRanges.reserveCapacity(nodes.count)

    for node in nodes {
        let fallback = absoluteUTF16Offset..<(absoluteUTF16Offset + source.utf16.count)
        syntaxRanges.append(node.range.flatMap(sourceMap.absoluteRange(for:)) ?? fallback)
    }

    var blocks: [ParsedMarkdown.TopLevelBlock] = []
    var codeRanges: [Range<Int>] = []
    var sameOffsetOrdinals: [Int: Int] = [:]

    for (index, node) in nodes.enumerated() {
        let syntaxRange = syntaxRanges[index]
        let sourceStart = index == 0 ? absoluteUTF16Offset : syntaxRange.lowerBound
        let sourceEnd = index + 1 < syntaxRanges.count
            ? syntaxRanges[index + 1].lowerBound
            : absoluteUTF16Offset + source.utf16.count
        let sourceRange = sourceStart..<max(sourceStart, sourceEnd)
        let ordinal = sameOffsetOrdinals[syntaxRange.lowerBound, default: 0]
        sameOffsetOrdinals[syntaxRange.lowerBound] = ordinal + 1
        let id = MarkdownSourceID(utf16SourceOffset: syntaxRange.lowerBound, siblingOrdinal: ordinal)
        let converted = MarkdownDocumentBuilder(sourceMap: sourceMap).block(from: node, id: id)
        let kind: ParsedMarkdown.TopLevelBlock.Kind
        if let paragraph = converted.paragraph {
            kind = .paragraph(paragraph)
        } else {
            kind = .semantic
        }
        if node is CodeBlock {
            codeRanges.append(syntaxRange)
        }
        blocks.append(.init(
            absoluteSourceRange: sourceRange,
            syntaxSourceRange: syntaxRange,
            startLine: node.range?.lowerBound.line ?? 1,
            endLine: node.range?.upperBound.line ?? 1,
            kind: kind,
            block: converted.block
        ))
    }

    return ParsedMarkdown(blocks: blocks, codeRanges: codeRanges)
}

private struct MarkdownDocumentBuilder {
    let sourceMap: MarkdownSourceMap

    func block(from markup: Markup, id: MarkdownSourceID? = nil) -> (block: MarkdownBlock, paragraph: MarkdownParagraph?) {
        let blockID = id ?? sourceID(for: markup)
        switch markup {
        case let paragraph as Paragraph:
            let value = MarkdownParagraph(id: blockID, content: inlineContent(of: paragraph))
            return (MarkdownBlock(id: blockID, content: .prose(paragraphs: [value])), value)
        case let heading as Heading:
            return (MarkdownBlock(id: blockID, content: .heading(
                level: heading.level,
                content: inlineContent(of: heading)
            )), nil)
        case let list as UnorderedList:
            return (MarkdownBlock(id: blockID, content: .unorderedList(items: listItems(in: list))), nil)
        case let list as OrderedList:
            return (MarkdownBlock(id: blockID, content: .orderedList(
                startIndex: list.startIndex,
                items: listItems(in: list)
            )), nil)
        case let quote as BlockQuote:
            return (MarkdownBlock(id: blockID, content: .blockQuote(
                blocks: quote.children.map { block(from: $0).block }
            )), nil)
        case is ThematicBreak:
            return (MarkdownBlock(id: blockID, content: .thematicBreak), nil)
        case let code as CodeBlock:
            return (MarkdownBlock(id: blockID, content: .codeBlock(.init(
                code: code.code,
                language: code.language
            ))), nil)
        case let table as Table:
            return (MarkdownBlock(id: blockID, content: .table(markdownTable(from: table))), nil)
        case is HTMLBlock:
            return (MarkdownBlock(id: blockID, content: .literal(source(for: markup))), nil)
        default:
            return (MarkdownBlock(id: blockID, content: .literal(source(for: markup))), nil)
        }
    }

    private func markdownTable(from table: Table) -> MarkdownTable {
        MarkdownTable(
            columnAlignments: table.columnAlignments.map { columnAlignment(from: $0) },
            header: table.head.isEmpty ? nil : row(from: table.head),
            rows: Array(table.body.rows).map { row(from: $0) }
        )
    }

    private func row(from container: some TableCellContainer) -> MarkdownTable.Row {
        // A zero `colspan` marks a cell already covered by a spanning cell in the same row.
        let cells = Array(container.cells).filter { $0.colspan > 0 }
        return MarkdownTable.Row(cells: cells.map { cell in
            MarkdownTable.Cell(content: inlineContent(of: cell), columnSpan: Int(cell.colspan))
        })
    }

    private func columnAlignment(from alignment: Table.ColumnAlignment?) -> MarkdownTable.ColumnAlignment? {
        switch alignment {
        case .left?: .leading
        case .center?: .center
        case .right?: .trailing
        case nil: nil
        }
    }

    private func listItems(in markup: Markup) -> [MarkdownListItem] {
        markup.children.compactMap { child in
            guard let item = child as? ListItem else {
                return nil
            }
            let checkbox: MarkdownListItem.Checkbox?
            switch item.checkbox {
            case .checked?: checkbox = .checked
            case .unchecked?: checkbox = .unchecked
            case nil: checkbox = inferredCheckbox(for: item)
            }
            var blocks = item.children.map { block(from: $0).block }
            if checkbox != nil {
                blocks = removingTaskMarker(from: blocks)
            }
            return MarkdownListItem(
                id: sourceID(for: item),
                checkbox: checkbox,
                blocks: blocks
            )
        }
    }

    private func inferredCheckbox(for item: ListItem) -> MarkdownListItem.Checkbox? {
        var candidate = source(for: item).split(separator: "\n", maxSplits: 1).first?[...] ?? ""[...]
        candidate = candidate.drop(while: { $0 == " " || $0 == "\t" })
        while candidate.hasPrefix(">") {
            candidate = candidate.dropFirst().drop(while: { $0 == " " || $0 == "\t" })
        }
        if let marker = candidate.first, "-*+".contains(marker) {
            candidate = candidate.dropFirst()
        } else {
            candidate = candidate.drop(while: \.isNumber)
            if let marker = candidate.first, ".)".contains(marker) {
                candidate = candidate.dropFirst()
            }
        }
        candidate = candidate.drop(while: { $0 == " " || $0 == "\t" })
        let marker = candidate.prefix(3).lowercased()
        if marker == "[x]" {
            return .checked
        }
        if marker == "[ ]" {
            return .unchecked
        }
        return nil
    }

    private func removingTaskMarker(from blocks: [MarkdownBlock]) -> [MarkdownBlock] {
        guard let first = blocks.first,
              case .prose(let paragraphs) = first.content,
              let firstParagraph = paragraphs.first else {
            return blocks
        }
        let characters = firstParagraph.content.characters
        let text = String(characters)
        guard text.hasPrefix("[x] ") || text.hasPrefix("[X] ") || text.hasPrefix("[ ] ") else {
            return blocks
        }
        let contentStart = characters.index(characters.startIndex, offsetBy: 4)
        let trimmed = AttributedString(firstParagraph.content[contentStart...])
        let updatedParagraph = MarkdownParagraph(id: firstParagraph.id, content: trimmed)
        var updatedParagraphs = paragraphs
        updatedParagraphs[0] = updatedParagraph
        var updatedBlocks = blocks
        updatedBlocks[0] = MarkdownBlock(id: first.id, content: .prose(paragraphs: updatedParagraphs))
        return updatedBlocks
    }

    private func inlineContent(of markup: Markup) -> AttributedString {
        var builder = MarkdownInlineBuilder()
        for child in markup.children {
            builder.append(child)
        }
        return builder.result
    }

    private func sourceID(for markup: Markup) -> MarkdownSourceID {
        let offset = markup.range
            .flatMap(sourceMap.absoluteRange(for:))?
            .lowerBound ?? sourceMap.absoluteUTF16Offset
        return MarkdownSourceID(utf16SourceOffset: offset)
    }

    private func source(for markup: Markup) -> String {
        guard let range = markup.range.flatMap(sourceMap.absoluteRange(for:)) else {
            return ""
        }
        return sourceMap.source(inAbsoluteRange: range)
    }
}

private struct MarkdownInlineBuilder {
    private static let linkDetector = try? NSDataDetector(
        types: NSTextCheckingResult.CheckingType.link.rawValue
    )

    var result = AttributedString()
    private var intent: InlinePresentationIntent = []
    private var link: URL?

    mutating func append(_ markup: Markup) {
        switch markup {
        case let text as Markdown.Text:
            appendPlainText(text.string)
        case let strong as Strong:
            appendChildren(of: strong, adding: .stronglyEmphasized)
        case let emphasis as Emphasis:
            appendChildren(of: emphasis, adding: .emphasized)
        case let strike as Strikethrough:
            appendChildren(of: strike, adding: .strikethrough)
        case let code as InlineCode:
            let previous = intent
            intent.insert(.code)
            appendLiteral(code.code)
            intent = previous
        case let markdownLink as Markdown.Link:
            appendChildren(of: markdownLink, linkedTo: markdownLink.destination)
        case is SoftBreak, is LineBreak:
            appendLiteral("\n")
        case let image as Image:
            appendChildren(of: image, linkedTo: image.source)
        case let html as InlineHTML:
            appendLiteral(html.rawHTML)
        default:
            appendChildren(of: markup)
        }
    }

    private mutating func appendChildren(of markup: Markup) {
        for child in markup.children {
            append(child)
        }
    }

    private mutating func appendChildren(of markup: Markup, adding value: InlinePresentationIntent) {
        let previous = intent
        intent.insert(value)
        appendChildren(of: markup)
        intent = previous
    }

    private mutating func appendChildren(of markup: Markup, linkedTo destination: String?) {
        let previous = link
        link = destination.flatMap(URL.init(string:))
        appendChildren(of: markup)
        link = previous
    }

    private mutating func appendPlainText(_ text: String) {
        guard link == nil, !intent.contains(.code),
              let detector = Self.linkDetector else {
            appendLiteral(text)
            return
        }

        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var cursor = text.startIndex
        for match in detector.matches(in: text, range: range) where match.resultType == .link {
            guard let matchRange = Range(match.range, in: text), let url = match.url else {
                continue
            }
            appendLiteral(String(text[cursor..<matchRange.lowerBound]))
            let previousLink = link
            link = url
            appendLiteral(String(text[matchRange]))
            link = previousLink
            cursor = matchRange.upperBound
        }
        appendLiteral(String(text[cursor...]))
    }

    private mutating func appendLiteral(_ text: String) {
        guard !text.isEmpty else {
            return
        }
        var fragment = AttributedString(text)
        if !intent.isEmpty {
            fragment.inlinePresentationIntent = intent
        }
        if let link {
            fragment.link = link
        }
        result.append(fragment)
    }
}

func inlineMarkdownAttributedString(from source: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .returnPartiallyParsedIfPossible
    )
    return (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
}

extension String {
    func substring(utf16Offsets range: Range<Int>) -> String {
        let utf16 = utf16
        let clampedLowerBound = min(max(0, range.lowerBound), utf16.count)
        let clampedUpperBound = min(max(clampedLowerBound, range.upperBound), utf16.count)
        let lowerUTF16Index = utf16.index(utf16.startIndex, offsetBy: clampedLowerBound)
        let upperUTF16Index = utf16.index(utf16.startIndex, offsetBy: clampedUpperBound)
        let lowerIndex = String.Index(lowerUTF16Index, within: self) ?? startIndex
        let upperIndex = String.Index(upperUTF16Index, within: self) ?? endIndex
        return String(self[lowerIndex..<upperIndex])
    }
}
