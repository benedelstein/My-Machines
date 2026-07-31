import Domain
import MarkdownParsing
import SwiftUI

struct AgentSessionRenderItemView: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let item: AgentSessionRenderItem
    let isActive: Bool
    let isStreaming: Bool
    let openDetails: () -> Void

    init(
        item: AgentSessionRenderItem,
        isActive: Bool = false,
        isStreaming: Bool = false,
        openDetails: @escaping () -> Void
    ) {
        self.item = item
        self.isActive = isActive
        self.isStreaming = isStreaming
        self.openDetails = openDetails
    }

    var body: some View {
        switch item {
        case .text(let item):
            Text(verbatim: item.text)
                .font(style.responseTextFont)
                .foregroundStyle(theme.labelColor)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .markdown(let item):
            MarkdownPartsView(parts: item.parts, isStreaming: isStreaming)
        case .reasoning(let item):
            VStack(alignment: .leading, spacing: style.gridSize / 2) {
                Label("Thinking", systemImage: "brain")
                    .styledFont(.caption)
                    .foregroundStyle(theme.secondaryLabelColor)
                Text(verbatim: item.part.text)
                    .styledFont(.footnote)
                    .foregroundStyle(theme.secondaryLabelColor)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .actionItem(let item):
            Button(action: openDetails) {
                ToolActionInlineRow(item: item, isActive: isActive)
            }
            .buttonStyle(.bounce(0.97))
        }
    }
}

struct MarkdownPartsView: View {
    let parts: [MarkdownPart]
    let isStreaming: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(parts.enumerated()), id: \.element.id) { index, part in
                PartView(part: part, isFirst: index == 0, isStreaming: isStreaming)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension MarkdownPartsView {
    struct PartView: View {
        @Environment(\.style) private var style: Style

        let part: MarkdownPart
        let isFirst: Bool
        let isStreaming: Bool

        var body: some View {
            BlockView(block: part.block, partStability: part.stability, isStreaming: isStreaming)
                .padding(.top, topPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        private var topPadding: CGFloat {
            guard !isFirst, part.leadingBoundary == .block else {
                return 0
            }
            return style.gridSize * 1.5
        }
    }

    struct BlockView: View {
        @Environment(\.theme) private var theme: Theme
        @Environment(\.style) private var style: Style

        let block: MarkdownBlock
        let partStability: MarkdownPart.Stability
        let isStreaming: Bool

        @ViewBuilder
        var body: some View {
            switch block.content {
            case .prose(let paragraphs):
                ProseView(paragraphs: paragraphs)
            case .heading(let level, let content):
                Text(content)
                    .font(headingFont(level: level))
                    .foregroundStyle(theme.labelColor)
                    .fixedSize(horizontal: false, vertical: true)
            case .unorderedList(let items):
                ListView(items: items, startIndex: nil, partStability: partStability, isStreaming: isStreaming)
            case .orderedList(let startIndex, let items):
                ListView(
                    items: items,
                    startIndex: startIndex,
                    partStability: partStability,
                    isStreaming: isStreaming
                )
            case .blockQuote(let blocks):
                BlockQuoteView(blocks: blocks, partStability: partStability, isStreaming: isStreaming)
            case .thematicBreak:
                DividerView()
            case .codeBlock(let codeBlock):
                CodeBlockView(
                    codeBlock: codeBlock,
                    isActive: isStreaming && partStability == .active
                )
            case .table(let table):
                TableView(table: table)
            case .literal(let source):
                Text(verbatim: source)
                    .font(style.responseTextFont)
                    .foregroundStyle(theme.labelColor)
                    .fixedSize(horizontal: false, vertical: true)
            case .sourceOnly:
                EmptyView()
            }
        }

        private func headingFont(level: Int) -> Font {
            switch level {
            case 1: .title2.bold()
            case 2: .title3.bold()
            case 3: .headline.bold()
            case 4: .headline
            case 5: .subheadline.bold()
            default: .subheadline
            }
        }
    }

    struct ProseView: View {
        @Environment(\.theme) private var theme: Theme
        @Environment(\.style) private var style: Style

        let paragraphs: [MarkdownParagraph]

        var body: some View {
            VStack(alignment: .leading, spacing: style.gridSize) {
                ForEach(paragraphs) { paragraph in
                    Text(paragraph.content)
                        .font(style.responseTextFont)
                        .foregroundStyle(theme.labelColor)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    struct ListView: View {
        let items: [MarkdownListItem]
        let startIndex: UInt?
        let partStability: MarkdownPart.Stability
        let isStreaming: Bool

        private var groups: [ListRenderGroup] {
            stride(from: 0, to: items.count, by: 25).map { offset in
                let groupItems = Array(items[offset..<min(offset + 25, items.count)])
                return ListRenderGroup(
                    id: groupItems[0].id,
                    startingItemOffset: offset,
                    items: groupItems
                )
            }
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(groups) { group in
                    ListRenderGroupView(
                        group: group,
                        startIndex: startIndex,
                        partStability: partStability,
                        isStreaming: isStreaming
                    )
                    .equatable()
                }
            }
        }
    }

    struct ListRenderGroup: Identifiable, Equatable {
        let id: MarkdownSourceID
        let startingItemOffset: Int
        let items: [MarkdownListItem]
    }

    struct ListRenderGroupView: View, Equatable {
        let group: ListRenderGroup
        let startIndex: UInt?
        let partStability: MarkdownPart.Stability
        let isStreaming: Bool

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(group.items.enumerated()), id: \.element.id) { offset, item in
                    ListItemView(
                        item: item,
                        marker: marker(for: item, offset: group.startingItemOffset + offset),
                        partStability: partStability,
                        isStreaming: isStreaming
                    )
                }
            }
        }

        private func marker(for item: MarkdownListItem, offset: Int) -> String {
            if let checkbox = item.checkbox {
                return checkbox == .checked ? "checkmark.square.fill" : "square"
            }
            if let startIndex {
                return "\(startIndex + UInt(offset))."
            }
            return "•"
        }
    }

    struct ListItemView: View {
        @Environment(\.theme) private var theme: Theme
        @Environment(\.style) private var style: Style

        let item: MarkdownListItem
        let marker: String
        let partStability: MarkdownPart.Stability
        let isStreaming: Bool

        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: style.gridSize) {
                if item.checkbox != nil {
                    Image(systemName: marker)
                        .foregroundStyle(theme.secondaryLabelColor)
                        .frame(width: 20, alignment: .trailing)
                } else {
                    Text(marker)
                        .font(style.responseTextFont)
                        .foregroundStyle(theme.secondaryLabelColor)
                        .frame(minWidth: 20, alignment: .trailing)
                }
                VStack(alignment: .leading, spacing: style.gridSize) {
                    ForEach(item.blocks) { block in
                        BlockView(block: block, partStability: partStability, isStreaming: isStreaming)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    struct BlockQuoteView: View {
        @Environment(\.theme) private var theme: Theme
        @Environment(\.style) private var style: Style

        let blocks: [MarkdownBlock]
        let partStability: MarkdownPart.Stability
        let isStreaming: Bool

        var body: some View {
            HStack(alignment: .top, spacing: style.gridSize) {
                Rectangle()
                    .fill(theme.outlineColor)
                    .frame(width: 2)
                VStack(alignment: .leading, spacing: style.gridSize) {
                    ForEach(blocks) { block in
                        BlockView(block: block, partStability: partStability, isStreaming: isStreaming)
                    }
                }
                .foregroundStyle(theme.secondaryLabelColor)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    struct DividerView: View {
        @Environment(\.theme) private var theme: Theme

        var body: some View {
            Rectangle()
                .fill(theme.outlineColor)
                .frame(height: 0.5)
                .frame(maxWidth: .infinity)
        }
    }

    struct CodeBlockView: View {
        @Environment(\.theme) private var theme: Theme
        @Environment(\.style) private var style: Style

        let codeBlock: MarkdownCodeBlock
        let isActive: Bool

        var body: some View {
            CodePreviewChrome(
                text: codeBlock.code,
                copyAccessibilityLabel: "Copy code",
                background: .secondary,
                title: codeBlock.language
            ) {
                codeContent
            }
            .accessibilityValue(isActive ? "Streaming" : "Complete")
        }

        private var codeContent: some View {
            ScrollView(.horizontal) {
                Text(verbatim: codeBlock.code.isEmpty ? " " : codeBlock.code)
                    .fixedSize(horizontal: true, vertical: true)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(theme.labelColor)
                    .textSelection(.enabled)
                    .padding(.top, style.gridSize)
                    .padding(.bottom, style.gridSize)
                    .padding(.leading, style.gridSize)
                    .padding(.trailing, style.gridSize * 5)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct ToolActionInlineRow: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let item: AgentSessionRenderItem.ActionItem
    let isActive: Bool

    var body: some View {
        let title = item.title(isActive: isActive)

        HStack(spacing: style.gridSize) {
            Image(systemName: item.iconName)
                .font(style.caption2Font)
                .foregroundStyle(theme.accentBlue)
                .frame(width: 15)

            HStack(spacing: 2) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .styledFont(.footnote)
                        .foregroundStyle(theme.secondaryLabelColor)
                        .lineLimit(1)
                }

                Image(systemName: "chevron.right")
                    .font(.body(9))
                    .foregroundStyle(theme.tertiaryLabelColor)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().foregroundStyle(theme.tertiaryBackgroundColor))
        .animation(style.fadeAnimation, value: title)
        .transition(style.fadeTransition)
    }
}
