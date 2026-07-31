import Domain
import Foundation
import SwiftUI

struct DetailSection<Content: View>: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: style.gridSize) {
            Text(title)
                .styledFont(.caption)
                .foregroundStyle(theme.secondaryLabelColor)
                .textCase(.uppercase)
            content
                .styledFont(.subheadline)
                .foregroundStyle(theme.labelColor)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct CodePreview: View {
    @Environment(\.style) private var style: Style
    @Environment(\.theme) private var theme: Theme

    let text: String
    private let layout: CodePreviewLayout

    init(text: String) {
        self.text = text
        layout = .wrapped
    }

    fileprivate init(text: String, layout: CodePreviewLayout) {
        self.text = text
        self.layout = layout
    }

    var body: some View {
        CodePreviewChrome(
            text: text,
            copyAccessibilityLabel: "Copy",
            background: .primary
        ) {
            codeContent
        }
    }

    @ViewBuilder
    private var codeContent: some View {
        switch layout {
        case .wrapped:
            wrappedCodeContent
        case .filePreview:
            scrollingCodeContent
        }
    }

    private var wrappedCodeContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(lines.indices, id: \.self) { index in
                HStack(alignment: .firstTextBaseline, spacing: style.gridSize) {
                    if hasLineNumbers {
                        codeLine(lines[index].lineNumber ?? "", wraps: false)
                            .foregroundStyle(theme.tertiaryLabelColor)
                            .frame(minWidth: lineNumberWidth, alignment: .trailing)
                    }

                    codeLine(lines[index].content, wraps: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.vertical, style.gridSize)
        .padding(.leading, style.gridSize)
        .padding(.trailing, style.gridSize * 5)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var scrollingCodeContent: some View {
        HStack(alignment: .top, spacing: 0) {
            if hasLineNumbers {
                lineNumberGutter
            }

            ScrollView(.horizontal, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(lines.indices, id: \.self) { index in
                        codeLine(lines[index].content, wraps: false)
                    }
                }
                .padding(.vertical, style.gridSize)
                .padding(.leading, style.gridSize)
                .padding(.trailing, style.gridSize * 5)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var lineNumberGutter: some View {
        VStack(alignment: .trailing, spacing: 0) {
            ForEach(lines.indices, id: \.self) { index in
                codeLine(lines[index].lineNumber ?? "", wraps: false)
                    .foregroundStyle(theme.tertiaryLabelColor)
                    .frame(minWidth: lineNumberWidth, alignment: .trailing)
            }
        }
        .padding(.vertical, style.gridSize)
        .padding(.leading, style.gridSize)
        .padding(.trailing, style.gridSize)
        .background(theme.backgroundColor)
    }

    private func codeLine(_ value: String, wraps: Bool) -> some View {
        Text(verbatim: value.isEmpty ? " " : value)
            .font(.system(.footnote, design: .monospaced))
            .foregroundStyle(theme.labelColor)
            .lineLimit(wraps ? nil : 1)
            .fixedSize(horizontal: !wraps, vertical: false)
    }

    private var lines: [CodePreviewLine] {
        CodePreviewLine.lines(from: text)
    }

    private var hasLineNumbers: Bool {
        lines.contains { $0.lineNumber != nil }
    }

    private var lineNumberWidth: CGFloat {
        CGFloat(lines.compactMap(\.lineNumber).map(\.count).max() ?? 1) * 8
    }
}

struct FilePreview: View {
    let text: String

    var body: some View {
        CodePreview(text: text, layout: .filePreview)
    }
}

private enum CodePreviewLayout {
    case wrapped
    case filePreview
}

private struct CodePreviewLine: Equatable {
    let lineNumber: String?
    let content: String

    static func lines(from text: String) -> [CodePreviewLine] {
        let rawLines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        let parsedLines = rawLines.map(parseLineNumber)
        let numberedLineCount = parsedLines.filter { $0.lineNumber != nil }.count
        let shouldShowGutter = numberedLineCount > 1
            && parsedLines.allSatisfy { line in
                line.lineNumber != nil || line.content.isEmpty
            }
        return shouldShowGutter
            ? parsedLines
            : rawLines.map { CodePreviewLine(lineNumber: nil, content: $0) }
    }

    private static func parseLineNumber(_ line: String) -> CodePreviewLine {
        let trimmedLeading = line.drop(while: \.isWhitespace)
        let digits = trimmedLeading.prefix(while: \.isNumber)
        guard !digits.isEmpty else {
            return CodePreviewLine(lineNumber: nil, content: line)
        }

        let remaining = trimmedLeading.dropFirst(digits.count)
        guard remaining.first?.isWhitespace == true else {
            return CodePreviewLine(lineNumber: nil, content: line)
        }

        return CodePreviewLine(
            lineNumber: String(digits),
            content: String(remaining.drop(while: \.isWhitespace))
        )
    }
}

struct ValueList: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let values: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: style.gridSize / 2) {
            ForEach(displayValues, id: \.self) { value in
                Text(value)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(theme.labelColor)
                    .textSelection(.enabled)
            }
        }
    }

    private var displayValues: [String] {
        values.isEmpty ? ["No details available"] : values
    }
}

extension AgentSessionRenderItem {
    var groupActions: [NormalizedToolAction] {
        guard case .actionItem(.group(let group)) = self else {
            return []
        }
        return group.actions
    }
}

extension NormalizedToolAction.LineRange {
    var displayValue: String {
        if let end {
            return "\(start)-\(end)"
        }
        return "\(start)"
    }
}

extension JSONValue? {
    var prettyPrintedJSON: String {
        guard let self else {
            return "No details available"
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(self), let string = String(data: data, encoding: .utf8) else {
            return "Unable to render JSON"
        }
        return string
    }
}
