import SwiftUI
import UIKit

struct PromptComposerImageAttachmentPreview: Identifiable, Equatable {
    let id: UUID
    /// Downsampled local image used for preview; nil while a picker selection is loading.
    let previewImage: UIImage?
    let status: ImageAttachmentDraftStatus
    let canRetry: Bool

    static func == (
        lhs: PromptComposerImageAttachmentPreview,
        rhs: PromptComposerImageAttachmentPreview
    ) -> Bool {
        lhs.id == rhs.id
            && lhs.status == rhs.status
            && lhs.canRetry == rhs.canRetry
            && lhs.previewImage === rhs.previewImage
    }
}

extension PromptComposerView {
    struct ImageSourceMenu: View {
        @Environment(\.composerStyle) var composerStyle: ComposerStyle
        @Environment(\.theme) private var theme: Theme
        @Environment(\.style) private var style: Style

        let isDisabled: Bool
        let onOpenCamera: () -> Void
        let onOpenPhotos: () -> Void

        var body: some View {
            Menu {
                Button(action: onOpenCamera) {
                    Label("Camera", systemImage: "camera")
                }
                .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))

                Button(action: onOpenPhotos) {
                    Label("Photos", systemImage: "photo.on.rectangle")
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .semibold))
                    .squareFrame(size: composerStyle.bottomButtonSize)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.highlight)
            .foregroundStyle(theme.secondaryLabelColor)
            .disabled(isDisabled)
            .accessibilityLabel("Add images")
        }
    }

    struct AttachmentPreviews: View {
        @Environment(\.theme) private var theme: Theme
        @Environment(\.style) private var style: Style

        let attachments: [PromptComposerImageAttachmentPreview]
        let onRemove: (UUID) -> Void
        let onRetry: (UUID) -> Void

        var body: some View {
            VStack(alignment: .leading, spacing: style.gridSize) {
                if !attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: style.gridSize) {
                            ForEach(attachments) { attachment in
                                AttachmentThumbnail(attachment: attachment) {
                                    withAnimation {
                                        onRemove(attachment.id)
                                    }
                                } onRetry: {
                                    onRetry(attachment.id)
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 12)
                        .padding(.bottom, 2)
                    }
                }
            }
        }
    }
}

extension PromptComposerView {
    private struct AttachmentThumbnail: View {
        @Environment(\.theme) private var theme: Theme
        @Environment(\.style) private var style: Style

        let attachment: PromptComposerImageAttachmentPreview
        let onRemove: () -> Void
        let onRetry: () -> Void

        var body: some View {
            Button {
                guard attachment.canRetry, attachment.status.isFailed else {
                    return
                }
                onRetry()
            } label: {
                content
            }
            .buttonStyle(.bounce)
        }

        var content: some View {
            ZStack(alignment: .topTrailing) {
                thumbnailImage
                    .frame(width: style.gridSize * 8, height: style.gridSize * 8)
                    .clipShape(shape)
                    .overlay {
                        shape.stroke(outlineColor, lineWidth: style.outlineThickness)
                    }

                statusOverlay

                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(theme.labelColor)
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(theme.backgroundColor.opacity(0.86)))
                }
                .buttonStyle(.plain)
                .padding(4)
                .accessibilityLabel("Remove image")
            }
            .frame(width: style.gridSize * 8, height: style.gridSize * 8)
            .contentShape(shape)
            .accessibilityAddTraits(attachment.canRetry && attachment.status.isFailed ? .isButton : [])
        }

        @ViewBuilder
        private var thumbnailImage: some View {
            if let image = attachment.previewImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "photo")
                    .foregroundStyle(theme.secondaryLabelColor)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(theme.loadingBackgroundColor)
            }
        }

        @ViewBuilder
        private var statusOverlay: some View {
            switch attachment.status {
            case .uploading:
                ZStack {
                    Rectangle()
                        .fill(.black.opacity(0.4))
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                }
                .clipShape(shape)
            case .uploaded:
                EmptyView()
            case .failed:
                ZStack {
                    shape.fill(Color.black.opacity(0.25))
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(theme.errorRed)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        }

        private var shape: RoundedRectangle {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
        }

        private var outlineColor: Color {
            if case .failed = attachment.status {
                return theme.errorRed
            }
            return theme.outlineColor
        }
    }
}
