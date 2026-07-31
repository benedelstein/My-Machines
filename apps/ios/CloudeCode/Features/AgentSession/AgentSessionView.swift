import CoreAPI
import Domain
import Entities
import Foundation
import SwiftUI

struct AgentSessionView: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style
    @Environment(\.showToast) private var showToast: ShowToastAction?
    @Environment(\.dismiss) private var dismiss: DismissAction

    @State private var store: AgentSessionViewModel
    @State private var destination: Modal<Destination>?
    @State private var composerHeight: CGFloat = 0
    @State private var transcriptScrollCoordinator: SessionTranscriptScrollCoordinator =
        SessionTranscriptScrollCoordinator()
    @State private var renamePromptPresented: Bool = false
    @State private var deleteConfirmationPresented: Bool = false
    @State private var proposedSessionTitle: String = ""

    init(store: AgentSessionViewModel) {
        _store = State(initialValue: store)
    }

    private var showsRepoBranchPicker: Bool {
        store.isDraftMode && !store.isCreatingSession && store.draft != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            SessionScrollView(
                store: store,
                destination: $destination,
                keyboardDismissPadding: composerHeight,
                scrollCoordinator: transcriptScrollCoordinator
            )
            .safeSafeAreaBar(edge: .bottom) {
                ComposerView(
                    vm: store,
                    showsRepoBranchPicker: showsRepoBranchPicker,
                    onConnectProvider: showProviderConnection,
                    onComposerSizeChange: updateComposerHeight
                )
                    .padding(.horizontal, style.horizontalPadding)
            }
        }
        .overlay {
            ScrollBottomButton(
                scrollCoordinator: transcriptScrollCoordinator,
                composerHeight: composerHeight
            )
        }
        .background(theme.backgroundColor)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(navigationTitle)
        .toolbar {
            ToolbarItem(placement: .principal) {
                sessionHeader
            }
            if store.session != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    sessionActionsMenu
                }
            }
        }
        .toolbarTitleDisplayMode(.inline)
        .modifier(Destinations(destination: $destination) { context in
            store.selectDefaultModel(for: context.providerId)
        })
        .alert("Rename session", isPresented: $renamePromptPresented) {
            TextField("Session name", text: $proposedSessionTitle)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                Task {
                    _ = await store.renameSession(to: proposedSessionTitle)
                }
            }
            .disabled(!isProposedSessionTitleValid)
        }
        .alert("Delete session?", isPresented: $deleteConfirmationPresented) {
            Button("Delete", role: .destructive) {
                Task.detached { [store] in
                    _ = await store.deleteSession()
                }
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes \(store.session?.title ?? "this session").")
        }
        .task {
            await store.bind()
        }
        .onChange(of: requiredProviderConnection, initial: true) { _, requirement in
            guard let requirement, destination == nil else { return }
            showProviderConnection(requirement.providerId)
        }
        .onChange(of: store.errorMessage) { _, errorMessage in
            guard let errorMessage else {
                return
            }
            showToast?(
                title: Text(verbatim: errorMessage),
                icon: Image(systemName: "exclamationmark.circle.fill")
            )
        }
        .onDisappear {
            store.unbind()
        }
    }

    private func updateComposerHeight(_ size: CGSize) {
        guard abs(composerHeight - size.height) > 0.5 else { return }
        withAnimation(style.springAnimation) {
            composerHeight = size.height
        }
    }

    private func showProviderConnection(_ provider: ProviderCatalogEntry) {
        showProviderConnection(provider.providerId)
    }

    private func showProviderConnection(_ providerId: ProviderId) {
        guard providerId == .claudeCode || providerId == .openaiCodex else { return }
        let catalogProvider = store.modelCatalogStore.catalog?.providers.first {
            $0.providerId == providerId
        }
        let liveConnection = store.clientState.providerConnection.flatMap { connection in
            ProviderId(rawValue: connection.provider) == providerId ? connection : nil
        }
        let providerName = catalogProvider?.providerName ?? defaultProviderName(for: providerId)
        Logger.info("Agent session presenting provider connection: \(providerId.rawValue)")
        destination = .sheet(.providerConnection(ProviderConnectionContext(
            providerId: providerId,
            providerName: providerName,
            requiresReauth: liveConnection?.requiresReauth ?? catalogProvider?.requiresReauth ?? false,
            sessionId: store.session?.id
        )))
    }

    private var requiredProviderConnection: ProviderConnectionRequirement? {
        guard !store.isDraftMode,
              let connection = store.clientState.providerConnection,
              !connection.connected else {
            return nil
        }
        return ProviderConnectionRequirement(
            providerId: ProviderId(rawValue: connection.provider),
            requiresReauth: connection.requiresReauth
        )
    }

    private func defaultProviderName(for providerId: ProviderId) -> String {
        switch providerId {
        case .claudeCode:
            "Claude Code"
        case .openaiCodex:
            "OpenAI Codex"
        case .unknown(let value):
            value
        }
    }

    private struct ProviderConnectionRequirement: Equatable {
        let providerId: ProviderId
        let requiresReauth: Bool
    }

    private var sessionHeader: some View {
        VStack(alignment: .center, spacing: 0) {
            Text(navigationTitle)
                .styledFont(.headline)
                .foregroundStyle(theme.labelColor)
                .lineLimit(1)

            HStack(spacing: style.gridSize) {
                Text(store.clientState.repoFullName ?? "No repository selected")
                    .lineLimit(1)
            }
            .styledFont(.caption)
            .foregroundStyle(theme.secondaryLabelColor)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var navigationTitle: String {
        store.session?.title ?? (store.isDraftMode ? "New session" : "Untitled session")
    }

    private var sessionActionsMenu: some View {
        Menu {
            Button {
                proposedSessionTitle = store.session?.title ?? ""
                renamePromptPresented = true
            } label: {
                Label("Rename session", systemImage: "pencil")
            }

            Button {
                Task.detached { [store] in
                    _ = await store.archiveSession()
                }
                dismiss()
            } label: {
                Label("Archive", systemImage: "archivebox")
            }

            Section {
                Button(role: .destructive) {
                    deleteConfirmationPresented = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .disabled(store.isPerformingSessionAction)
        .accessibilityLabel("Session actions")
    }

    private var isProposedSessionTitleValid: Bool {
        let trimmedTitle = proposedSessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmedTitle.isEmpty && trimmedTitle.count <= 60
    }
}

private extension AgentSessionView {
    // Isolate coordinator observation so scroll-button visibility changes do not
    // invalidate the rest of AgentSessionView's body.
    struct ScrollBottomButton: View {
        let scrollCoordinator: SessionTranscriptScrollCoordinator
        let composerHeight: CGFloat

        var body: some View {
            VStack(spacing: 0) {
                Spacer(minLength: 0)

                if scrollCoordinator.showsScrollToBottom {
                    SessionTranscriptScrollToBottomButton {
                        scrollCoordinator.requestScrollToBottom()
                    }
                }

                Color.clear
                    .frame(height: bottomSpacerHeight)
                    .allowsHitTesting(false)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .allowsHitTesting(scrollCoordinator.showsScrollToBottom)
            .animation(.easeInOut(duration: 0.25), value: bottomSpacerHeight)
        }

        private var bottomSpacerHeight: CGFloat {
            composerHeight + 16
        }
    }
}

extension AgentSessionView {
    struct MessageDisplayData: Identifiable, Equatable {
        let id: String
        let message: SessionMessage
        let renderItems: [AgentSessionRenderItem]
        let finalResponseStartIndex: Int?
    }

    // Keep collection row identity separate from SessionMessage.id so optimistic
    // user messages can receive their server id without replacing the visible row.
    // The message content lives in the view model's `messagesByID`.
    struct TranscriptRow: Identifiable, Equatable {
        let id: String
        var messageID: String
        var isStreaming: Bool
    }
}

private extension AgentSessionView {
    struct SessionScrollView: View {
        @Environment(\.style) private var style: Style

        let store: AgentSessionViewModel
        @Binding var destination: Modal<AgentSessionView.Destination>?
        let keyboardDismissPadding: CGFloat
        let scrollCoordinator: SessionTranscriptScrollCoordinator

        var rows: [AgentSessionView.TranscriptRow] {
            store.transcriptRows
        }

        var body: some View {
            // Always render the transcript scroll view so its structural identity
            // is stable; swapping it out (empty <-> transcript) re-hosts the
            // bottom safeAreaBar and breaks composer animations on first send.
            transcriptScrollView
                .overlay {
                    if !hasTranscriptItems, !store.hasLoadedMessages {
                        // todo loading skeleton
                        ProgressView()
                    }
                }
        }

        private var hasTranscriptItems: Bool {
            !transcriptItems.isEmpty
        }

        private var isWorkingIndicatorActive: Bool {
            store.isResponding || store.clientState.sessionSetupRun?.status == .running
        }

        private var transcriptItems: [SessionTranscriptItem] {
            // TranscriptRow.id is the stable row id assigned when the row is
            // created, so optimistic user rows never churn when their server id arrives.
            let messageItems = rows.compactMap { row -> SessionTranscriptItem? in
                guard let message = store.messagesByID[row.messageID] else {
                    assertionFailure("Transcript row \(row.id) has no message \(row.messageID)")
                    return nil
                }
                if message.isUser {
                    return .userMessage(id: row.id, message)
                }

                guard let displayData = store.assistantDisplayDataByRowID[row.id] else {
                    return nil
                }

                return .assistantMessage(
                    id: row.id,
                    displayData,
                    isStreaming: row.isStreaming
                )
            }

            return SessionTranscriptProjection.build(
                messageItems: messageItems,
                setupRun: store.clientState.sessionSetupRun,
                isSetupRunExpanded: store.isSetupRunExpanded,
                showsSetupRunPlaceholder: shouldShowSetupRunPlaceholder,
                isWorkingIndicatorActive: isWorkingIndicatorActive
            )
        }

        private var shouldShowSetupRunPlaceholder: Bool {
            store.session != nil
                && store.hasLoadedMessages
                && store.clientState.agentSettings.model.isEmpty
        }

        @ViewBuilder
        private var transcriptScrollView: some View {
            let scrollView = SessionTranscriptScrollView(
                items: transcriptItems,
                keyboardDismissPadding: keyboardDismissPadding,
                rowSpacing: style.spacing,
                contentPadding: style.spacing,
                scrollCoordinator: scrollCoordinator
            ) { item in
                transcriptRow(item)
                    .padding(.horizontal, style.horizontalPadding)
            }

            if #available(iOS 26.0, *) {
                scrollView
                    // necessary for scroll edge effects.
                    // we inset the content internally in the uiscrollview
                    .ignoresSafeArea(.container, edges: [.top, .bottom])
            } else {
                scrollView
                    .scrollClipDisabled()
            }
        }

        @ViewBuilder
        private func transcriptRow(_ item: SessionTranscriptItem) -> some View {
            Group {
                switch item {
                case .userMessage(_, let message):
                    UserMessageView(message: message)
                        .environment(\.openAgentSessionImage, openImageAction)
                case .assistantMessage(_, let displayData, let isStreaming):
                    AssistantMessageView(
                        displayData: displayData,
                        isStreaming: isStreaming,
                        destination: $destination
                    )
                case .setupRun(let state):
                    SetupRunView(
                        state: state,
                        onToggle: store.toggleSetupRunExpansion
                    )
                case .workingIndicator(let isActive):
                    WorkingIndicatorView(isActive: isActive)
                }
            }
            // Rows are hosted inside reused UIKit cells; the stable row id gives
            // SwiftUI explicit identity so state doesn't leak across cell reuse.
            // see https://lucasvandongen.dev/swiftui_uitableviewcell_reuse_id.php
            .id(item.id)
        }

        private var openImageAction: OpenAgentSessionImageAction {
            OpenAgentSessionImageAction { image in
                destination = .fullscreen(.image(image))
            }
        }
    }
}
