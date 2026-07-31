import Domain
import SwiftUI

struct AgentSessionToolDetailSheet: View {
    @Environment(\.dismiss) private var dismiss: DismissAction
    @State private var path: [ToolDetailRoute] = []

    let item: AgentSessionRenderItem

    var body: some View {
        NavigationStack(path: $path) {
            rootView
                .navigationDestination(for: ToolDetailRoute.self) { route in
                    routeView(route)
                }
                .toolbar {
                    ToolbarCloseButton {
                        dismiss()
                    }
                }
                .toolbarBackground(.hidden, for: .navigationBar)
        }
    }

    @ViewBuilder
    private var rootView: some View {
        renderItemRoot(item)
    }

    @ViewBuilder
    private func renderItemRoot(_ item: AgentSessionRenderItem) -> some View {
        switch item {
        case .actionItem(.single(let single)):
            ToolActionDetailView(action: single.action)
        case .actionItem(.group(let group)):
            ToolActionGroupDetailView(group: group, path: $path)
        case .text(let text):
            TextDetailView(title: "Message", text: text.text)
        case .markdown(let text):
            TextDetailView(title: "Message", text: text.text)
        case .reasoning(let reasoning):
            TextDetailView(title: "Reasoning", text: reasoning.part.text)
        }
    }

    @ViewBuilder
    private func routeView(_ route: ToolDetailRoute) -> some View {
        switch route {
        case .action(let index):
            if let action = item.groupActions[safe: index] {
                ToolActionDetailView(action: action)
            } else {
                ErrorStateView(title: "Tool not found") {
                    Image(systemName: "wrench.and.screwdriver")
                }
            }
        }
    }
}

private enum ToolDetailRoute: Hashable {
    case action(Int)
}

private struct ToolActionGroupDetailView: View {
    @Environment(\.style) private var style: Style

    let group: AgentSessionRenderItem.ActionGroup
    @Binding var path: [ToolDetailRoute]

    var body: some View {
        ScrollView {
            LazyVStack {
                ForEach(Array(group.actions.enumerated()), id: \.offset) { index, action in
                    Button {
                        path.append(.action(index))
                    } label: {
                        ToolActionNavigationRow(action: action)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .navigationTitle(group.title())
        .toolbarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
    }
}

private struct ToolActionNavigationRow: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let action: NormalizedToolAction

    var body: some View {
        HStack(spacing: style.gridSize) {
            Image(systemName: action.kind.iconName)
                .foregroundStyle(theme.accentBlue)
                .frame(width: style.gridSize * 3)

            VStack(alignment: .leading, spacing: 2) {
                Text(action.title())
                    .styledFont(.subheadline)
                    .foregroundStyle(theme.labelColor)
                    .lineLimit(1)
                if let subtitle = action.subtitle {
                    Text(subtitle)
                        .styledFont(.caption)
                        .foregroundStyle(theme.secondaryLabelColor)
                        .lineLimit(1)
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(style.captionFont)
                .foregroundStyle(theme.tertiaryLabelColor)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(theme.backgroundColor))
        .padding(.horizontal, style.horizontalPadding)
    }
}

private struct ToolActionDetailView: View {
    @Environment(\.style) private var style: Style

    let action: NormalizedToolAction

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: style.spacing) {
                payloadView
                if let errorText = action.errorText {
                    DetailSection(title: "Error") {
                        CodePreview(text: errorText)
                    }
                }
            }
            .padding(style.horizontalPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(.clear)
        .navigationTitle(action.title())
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var payloadView: some View {
        switch action.payload {
        case .read(let payload):
            ReadDetailView(payload: payload)
        case .edit(let payload):
            FileChangeDetailView(path: payload.path, title: "Diff", text: payload.diff)
        case .write(let payload):
            WriteDetailView(payload: payload)
        case .bash(let payload):
            BashDetailView(payload: payload)
        case .search(let payload):
            DetailSection(title: "Patterns") {
                ValueList(values: payload.patterns)
            }
        case .web(let payload):
            WebDetailView(payload: payload)
        case .todo(let payload):
            JSONDetailView(title: "Todos", value: payload.todos)
        case .plan(let payload):
            DetailSection(title: "Plan") {
                CodePreview(text: payload.plan)
            }
        case .other(let payload):
            OtherToolDetailView(payload: payload)
        }
    }
}

private struct ToolActionHeader: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let action: NormalizedToolAction

    var body: some View {
        VStack(alignment: .leading, spacing: style.gridSize / 2) {
            Label(action.title(), systemImage: action.kind.iconName)
                .styledFont(.headline)
                .foregroundStyle(theme.labelColor)
            Text(action.state)
                .styledFont(.caption)
                .foregroundStyle(theme.secondaryLabelColor)
        }
    }
}

private struct ReadDetailView: View {
    let payload: NormalizedToolAction.ReadAction

    var body: some View {
        DetailSection(title: "File") {
            ValueList(values: payload.paths)
        }

        if let lineRange = payload.lineRange {
            DetailSection(title: "Lines") {
                Text(lineRange.displayValue)
            }
        }

        DetailSection(title: "Preview") {
            FilePreview(text: payload.content ?? "No preview available")
        }
    }
}

private struct FileChangeDetailView: View {
    let path: String
    let title: String
    let text: String

    var body: some View {
        DetailSection(title: "File") {
            Text(path)
                .font(.system(.body, design: .monospaced))
        }
        DetailSection(title: title) {
            FilePreview(text: text.isEmpty ? "No details available" : text)
        }
    }
}

private struct WriteDetailView: View {
    let payload: NormalizedToolAction.WriteAction

    var body: some View {
        FileChangeDetailView(
            path: payload.path,
            title: payload.deleted ? "Deleted" : "Contents",
            text: payload.deleted ? "File deleted" : (payload.content ?? "No contents available")
        )
    }
}

private struct BashDetailView: View {
    let payload: NormalizedToolAction.BashAction

    var body: some View {
        DetailSection(title: "Command") {
            CodePreview(text: payload.command)
        }
        if let output = payload.output {
            DetailSection(title: "Output") {
                CodePreview(text: output)
            }
        }
        if let exitCode = payload.exitCode {
            DetailSection(title: "Exit Code") {
                Text(String(exitCode))
            }
        }
    }
}

private struct WebDetailView: View {
    let payload: NormalizedToolAction.WebAction

    var body: some View {
        DetailSection(title: payload.kind == .fetch ? "URL" : "Query") {
            Text(payload.url ?? payload.query ?? "No details available")
        }
    }
}

private struct OtherToolDetailView: View {
    let payload: NormalizedToolAction.OtherAction

    var body: some View {
        JSONDetailView(title: "Input", value: payload.input)
        JSONDetailView(title: "Output", value: payload.output)
    }
}

private struct JSONDetailView: View {
    let title: String
    let value: JSONValue?

    var body: some View {
        DetailSection(title: title) {
            CodePreview(text: value.prettyPrintedJSON)
        }
    }
}

private struct TextDetailView: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let title: String
    let text: String

    var body: some View {
        ScrollView {
            MarkdownText(text: text)
                .styledFont(.body)
                .foregroundStyle(theme.labelColor)
                .textSelection(.enabled)
                .padding(style.horizontalPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .background(.clear)
    }
}
