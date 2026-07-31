//
//  AgentSessionView+ComposerView.swift
//  CloudeCode
//
//  Created by Ben Edelstein on 6/26/26.
//

import CoreAPI
import Domain
import Foundation
import SwiftUI

extension AgentSessionView {
    struct ComposerView: View {
        @Environment(\.style) var style: Style

        @Bindable var vm: AgentSessionViewModel
        let showsRepoBranchPicker: Bool
        let onConnectProvider: (ProviderCatalogEntry) -> Void
        let onComposerSizeChange: (CGSize) -> Void
        @State private var composerFocused: Bool = false

        var body: some View {
            VStack(alignment: .leading, spacing: style.gridSize) {
                if showsRepoBranchPicker, let draft = vm.draft {
                    if draft.selectedRepo != nil {
                        EnvironmentPickerButton(draft: draft)
                            .transition(.blurReplace)
                    }

                    RepoBranchPickerBar(draft: draft)
                        .transition(.blurReplace)
                }

                measuredComposer
            }
            .animation(style.fadeAnimation, value: showsRepoBranchPicker)
            .animation(style.fadeAnimation, value: vm.clientState.pushedBranch)
            .task {
                if vm.isDraftMode {
                    try? await Task.sleep(for: .milliseconds(100))
                    composerFocused = true
                }
            }
        }

        private var measuredComposer: some View {
            VStack(alignment: .leading, spacing: style.gridSize) {
                if vm.clientState.pushedBranch != nil {
                    BranchBar(vm: vm)
                        .transition(.blurReplace)
                }

                promptComposer {
                    ModelPickerButton(
                        modelCatalog: vm.modelCatalogStore,
                        selectedModel: vm.modelSelection,
                        providerId: vm.modelProviderId,
                        providerConnection: vm.clientState.providerConnection,
                        restrictsProvider: vm.isCreatingSession || !vm.isDraftMode,
                        isLoadingSelection: vm.isModelSelectionLoading,
                        onSelectModel: { provider, model in
                            vm.selectModel(provider: provider, model: model)
                        },
                        onSelectEffort: { provider, effort in
                            vm.selectEffort(provider: provider, effort: effort)
                        },
                        onConnectProvider: onConnectProvider
                    )
                    .disabled(vm.isCreatingSession)
                }
            }
            .padding(.bottom, style.spacing)
            .readSize(onComposerSizeChange)
        }

        private func promptComposer<TrailingAccessory: View>(
            @ViewBuilder trailingAccessory: () -> TrailingAccessory = { EmptyView() }
        ) -> some View {
            PromptComposerView(
                text: $vm.draftText,
                focused: $composerFocused,
                placeholder: vm.composerPlaceholder,
                imageAttachments: vm.imageAttachmentDrafts.map(\.promptComposerPreview),
                imageSelectionErrorMessage: vm.imageSelectionErrorMessage,
                remainingImageSlots: vm.remainingImageAttachmentSlots,
                isImageInputEnabled: true,
                isSubmitDisabled: !vm.canSubmitDraft,
                isSubmitting: vm.isCreatingSession,
                isResponding: vm.isResponding,
                isCancelling: vm.isCancelling,
                isInterruptDisabled: !vm.canInterruptResponse,
                isAttachmentInputDisabled: vm.isCreatingSession,
                trailingAccessory: trailingAccessory,
                onSubmit: vm.submitUserMessage,
                onStop: vm.interruptResponse,
                onRemoveImageAttachment: vm.removeImageAttachment,
                onRetryImageAttachment: vm.retryImageAttachment,
                onPhotosSelected: vm.addImageAttachmentPhotoItems,
                onCameraImageCaptured: vm.addImageAttachmentCameraImage
            )
        }
    }
}

private extension ImageAttachmentDraft {
    var promptComposerPreview: PromptComposerImageAttachmentPreview {
        PromptComposerImageAttachmentPreview(
            id: id,
            previewImage: previewImage,
            status: status,
            canRetry: file != nil && status.isFailed
        )
    }
}
