import SwiftUI
import Domain
import UIKit

struct AssistantMessageView: View {
    @Environment(\.style) var style: Style
    @Environment(\.theme) private var theme: Theme
    @Environment(SessionTranscriptRowViewModel.self) private var rowViewModel

    private let partSpacing: CGFloat = 12

    let displayData: AgentSessionView.MessageDisplayData
    let isStreaming: Bool
    @Binding var destination: Modal<AgentSessionView.Destination>?

    @ViewBuilder
    var body: some View {
        VStack(alignment: .leading, spacing: partSpacing) {
            let items = displayData.renderItems
            let finalResponseStartIndex = displayData.finalResponseStartIndex
            let showsCollapsibleWorkTrace = !isStreaming && finalResponseStartIndex != nil

            if isStreaming || showsCollapsibleWorkTrace {
                TurnWorkHeaderView(
                    expanded: rowViewModel.workExpanded || isStreaming,
                    startedAt: displayData.message.workStartedAt,
                    endedAt: displayData.message.workEndedAt,
                    isStreaming: isStreaming,
                    collapsible: showsCollapsibleWorkTrace
                ) {
                    guard !isStreaming else { return }
                    setWorkExpanded(!rowViewModel.workExpanded)
                }
                .transition(style.fadeTransition)
            }

            if showsCollapsibleWorkTrace, let finalResponseStartIndex, rowViewModel.workExpanded {
                renderRows(
                    Array(items.prefix(finalResponseStartIndex)),
                    fullItems: items,
                    indexOffset: 0
                )
            }

            renderRows(
                Array(items.dropFirst(finalResponseStartIndex ?? 0)),
                fullItems: items,
                indexOffset: finalResponseStartIndex ?? 0
            )

            if displayData.message.isAborted {
                Text("Interrupted")
                    .styledFont(.caption)
                    .italic()
                    .foregroundStyle(theme.secondaryLabelColor)
            }

            // may want to just opacity this out with consistent frame
            // for no layout shift
            if let finalResponseCopyText {
                CopyFinalResponseButton(text: finalResponseCopyText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func renderRows(
        _ items: [AgentSessionRenderItem],
        fullItems: [AgentSessionRenderItem],
        indexOffset: Int
    ) -> some View {
        ForEach(Array(items.enumerated()), id: \.element.key) { index, item in
            let fullIndex = index + indexOffset
            let isActive = isActiveFinalGroup(
                item: item,
                index: fullIndex,
                items: fullItems
            )

            AgentSessionRenderItemView(
                item: item,
                isActive: isActive,
                isStreaming: isStreaming
            ) {
                destination = .sheet(.renderItem(item))
            }
            .transition(style.fadeTransition)
        }
    }

    private var finalResponseCopyText: String? {
        guard !isStreaming else {
            return nil
        }

        let startIndex = displayData.finalResponseStartIndex ?? 0
        let text = displayData.renderItems
            .dropFirst(startIndex)
            .compactMap(\.copyableText)
            .joined(separator: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return text.isEmpty ? nil : text
    }

    private func setWorkExpanded(_ expanded: Bool) {
        // NOTE - Not using animations here because it looks wonky
        // and doesnt sync with uikit resizing.
        // Can potentially revisit this later.
        let animationsWereEnabled = UIView.areAnimationsEnabled
        UIView.setAnimationsEnabled(false)

        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            rowViewModel.workExpanded = expanded
        }

        DispatchQueue.main.async {
            DispatchQueue.main.async {
                UIView.setAnimationsEnabled(animationsWereEnabled)
            }
        }
    }

    private func isActiveFinalGroup(
        item: AgentSessionRenderItem,
        index: Int,
        items: [AgentSessionRenderItem]
    ) -> Bool {
        guard isStreaming, index == items.endIndex - 1 else {
            return false
        }
        if case .actionItem(.group) = item {
            return true
        }
        return false
    }
}

private struct CopyFinalResponseButton: View {
    @Environment(\.theme) private var theme
    @Environment(\.showToast) private var showToast
    @Environment(\.hapticFeedbackPlayer) private var haptics

    let text: String

    var body: some View {
        Button(action: copyText) {
            Image(systemName: "square.on.square")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(theme.tertiaryLabelColor)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.highlight)
        .accessibilityLabel("Copy response")
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func copyText() {
        UIPasteboard.general.string = text
        haptics.play(.light)
        showToast?(
            title: "Copied",
            icon: Image(systemName: "square.on.square")
        )
    }
}

private extension AgentSessionRenderItem {
    var copyableText: String? {
        switch self {
        case .text(let item):
            item.text
        case .markdown(let item):
            item.text
        case .reasoning, .actionItem:
            nil
        }
    }
}
