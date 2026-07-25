import PhotosUI
import SwiftUI
import UIKit

struct PromptComposerView<TrailingAccessory: View>: View {
    @Environment(\.composerStyle) var composerStyle: ComposerStyle
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style
    @Environment(\.showToast) private var showToast: ShowToastAction?
    @Environment(\.hapticFeedbackPlayer) private var haptics

    @Binding private var text: String
    private var focused: Binding<Bool>
    private let placeholder: String
    private let imageAttachments: [PromptComposerImageAttachmentPreview]
    private let imageSelectionErrorMessage: String?
    private let remainingImageSlots: Int
    private let isImageInputEnabled: Bool
    private let isSubmitDisabled: Bool
    private let isSubmitting: Bool
    private let isResponding: Bool
    private let isCancelling: Bool
    private let isInterruptDisabled: Bool
    private let isAttachmentInputDisabled: Bool
    private let trailingAccessory: TrailingAccessory
    private let onSubmit: () -> Void
    private let onStop: () -> Void
    private let onRemoveImageAttachment: (UUID) -> Void
    private let onRetryImageAttachment: (UUID) -> Void
    private let onPhotosSelected: ([PhotosPickerItem]) -> Void
    private let onCameraImageCaptured: (UIImage) -> Void
    private let inlinePhotoPickerHeight: CGFloat = 350

    @State private var isInlinePhotoPickerVisible: Bool = false
    @State private var isPhotoSheetPresented: Bool = false
    @State private var isCameraPresented: Bool = false
    @State private var sheetSelectedPhotoItems: [PhotosPickerItem] = []
    @State private var notifiedFailedAttachmentIDs: Set<UUID> = []

    init(
        text: Binding<String>,
        focused: Binding<Bool>,
        placeholder: String,
        imageAttachments: [PromptComposerImageAttachmentPreview] = [],
        imageSelectionErrorMessage: String? = nil,
        remainingImageSlots: Int = 0,
        isImageInputEnabled: Bool = true,
        isSubmitDisabled: Bool,
        isSubmitting: Bool = false,
        isResponding: Bool = false,
        isCancelling: Bool = false,
        isInterruptDisabled: Bool = false,
        isAttachmentInputDisabled: Bool = false,
        @ViewBuilder trailingAccessory: () -> TrailingAccessory,
        onSubmit: @escaping () -> Void,
        onStop: @escaping () -> Void = {},
        onRemoveImageAttachment: @escaping (UUID) -> Void = { _ in },
        onRetryImageAttachment: @escaping (UUID) -> Void = { _ in },
        onPhotosSelected: @escaping ([PhotosPickerItem]) -> Void = { _ in },
        onCameraImageCaptured: @escaping (UIImage) -> Void = { _ in }
    ) {
        _text = text
        self.focused = focused
        self.placeholder = placeholder
        self.imageAttachments = imageAttachments
        self.imageSelectionErrorMessage = imageSelectionErrorMessage
        self.remainingImageSlots = remainingImageSlots
        self.isImageInputEnabled = isImageInputEnabled
        self.isSubmitDisabled = isSubmitDisabled
        self.isSubmitting = isSubmitting
        self.isResponding = isResponding
        self.isCancelling = isCancelling
        self.isInterruptDisabled = isInterruptDisabled
        self.isAttachmentInputDisabled = isAttachmentInputDisabled
        self.trailingAccessory = trailingAccessory()
        self.onSubmit = onSubmit
        self.onStop = onStop
        self.onRemoveImageAttachment = onRemoveImageAttachment
        self.onRetryImageAttachment = onRetryImageAttachment
        self.onPhotosSelected = onPhotosSelected
        self.onCameraImageCaptured = onCameraImageCaptured
    }

    var composerShape: some Shape {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                centerContent
                bottomBar
                    .padding(composerStyle.contentInset)
            }

            ZStack {
                inlinePhotoPickerContent
            }
            .frame(height: composerStyle.photoPickerHeight, alignment: .bottom)
            .frame(
                height: isInlinePhotoPickerVisible ?
                    composerStyle.photoPickerHeight :
                    composerStyle.bottomButtonSize + composerStyle.contentInset * 2,
                alignment: .bottom
            )
            // opacity must go after the frame
            .opacity(isInlinePhotoPickerVisible ? 1 : 0)
            .zIndex(1)
        }
        .clipShape(composerShape)
        .contentShape(composerShape)
        .promptComposerGlassBackground(
            in: composerShape,
            fallbackColor: theme.secondaryBackgroundColor,
            interactive: !isInlinePhotoPickerVisible
        )
        .onTapGesture {
            guard !isInlinePhotoPickerVisible else { return }
            focused.wrappedValue = true
        }
        .animation(style.springAnimation, value: isInlinePhotoPickerVisible)
        .animation(style.springAnimation, value: imageAttachments)
        .animation(style.springAnimation, value: imageSelectionErrorMessage)
        .photosPicker(
            isPresented: $isPhotoSheetPresented,
            selection: $sheetSelectedPhotoItems,
            maxSelectionCount: max(1, remainingImageSlots),
            selectionBehavior: .default,
            matching: .images,
            preferredItemEncoding: .current
        )
        .photosPickerStyle(.presentation)
        .fullScreenCover(isPresented: $isCameraPresented) {
            SystemCameraCaptureView { image in
                isCameraPresented = false
                onCameraImageCaptured(image)
            } onCancel: {
                isCameraPresented = false
            }
            .ignoresSafeArea()
        }
        .onChange(of: sheetSelectedPhotoItems) { _, newValue in
            handlePhotoSelection(newValue)
        }
        .onChange(of: imageAttachments) { _, newValue in
            showNewFailureHUDs(in: newValue)
        }
        .onChange(of: imageSelectionErrorMessage) { _, newValue in
            showImageSelectionErrorHUDIfNeeded(newValue)
        }
    }

    private var centerContent: some View {
        VStack(spacing: style.gridSize) {
            if !imageAttachments.isEmpty {
                AttachmentPreviews(
                    attachments: imageAttachments,
                    onRemove: onRemoveImageAttachment,
                    onRetry: onRetryImageAttachment
                )
                .transition(.opacity.animation(.easeIn(duration: 0.1)))
            }

            Editor(
                text: $text,
                focused: focused,
                placeholder: placeholder
            )
        }
    }

    private var inlinePhotoPickerContent: some View {
        InlinePhotoPickerContent(
            isVisible: isInlinePhotoPickerVisible,
            remainingImageSlots: remainingImageSlots,
            onDismiss: { setInlinePhotoPickerVisible(false) },
            onShowAllPhotos: { isPhotoSheetPresented = true },
            onPhotosSelected: { items in
                setInlinePhotoPickerVisible(false)
                onPhotosSelected(items)
            }
        )
    }

    @ViewBuilder
    var bottomBar: some View {
        HStack(alignment: .bottom, spacing: style.gridSize) {
            if isImageInputEnabled {
                imageSourceControl
            }

            Spacer()

            trailingAccessory

            SendButton(
                isSubmitDisabled: isSubmitDisabled,
                isSubmitting: isSubmitting,
                isResponding: isResponding,
                isCancelling: isCancelling,
                isInterruptDisabled: isInterruptDisabled,
                size: composerStyle.bottomButtonSize,
                onSubmit: onSubmit,
                onStop: onStop
            )
        }
    }

    private var imageSourceControl: some View {
        ZStack {
            ImageSourceMenu(
                isDisabled: isAttachmentInputDisabled || remainingImageSlots <= 0,
                onOpenCamera: openCamera,
                onOpenPhotos: showInlinePhotoPicker
            )
        }
        .frame(width: style.gridSize * 4, height: style.gridSize * 4)
        .animation(style.springAnimation, value: isInlinePhotoPickerVisible)
    }

    private func openCamera() {
        focused.wrappedValue = false
        isCameraPresented = true
    }

    private func showInlinePhotoPicker() {
        setInlinePhotoPickerVisible(true)
    }

    private func setInlinePhotoPickerVisible(_ isVisible: Bool) {
        withAnimation(style.springAnimation) {
            if isVisible {
                focused.wrappedValue = false
            }
            isInlinePhotoPickerVisible = isVisible
        }
    }

    private func handlePhotoSelection(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        sheetSelectedPhotoItems = []
        setInlinePhotoPickerVisible(false)
        onPhotosSelected(items)
    }
}

extension PromptComposerView where TrailingAccessory == EmptyView {
    init(
        text: Binding<String>,
        focused: Binding<Bool>,
        placeholder: String,
        imageAttachments: [PromptComposerImageAttachmentPreview] = [],
        imageSelectionErrorMessage: String? = nil,
        remainingImageSlots: Int = 0,
        isImageInputEnabled: Bool = true,
        isSubmitDisabled: Bool,
        isSubmitting: Bool = false,
        isResponding: Bool = false,
        isCancelling: Bool = false,
        isInterruptDisabled: Bool = false,
        isAttachmentInputDisabled: Bool = false,
        onSubmit: @escaping () -> Void,
        onStop: @escaping () -> Void = {},
        onRemoveImageAttachment: @escaping (UUID) -> Void = { _ in },
        onRetryImageAttachment: @escaping (UUID) -> Void = { _ in },
        onPhotosSelected: @escaping ([PhotosPickerItem]) -> Void = { _ in },
        onCameraImageCaptured: @escaping (UIImage) -> Void = { _ in }
    ) {
        self.init(
            text: text,
            focused: focused,
            placeholder: placeholder,
            imageAttachments: imageAttachments,
            imageSelectionErrorMessage: imageSelectionErrorMessage,
            remainingImageSlots: remainingImageSlots,
            isImageInputEnabled: isImageInputEnabled,
            isSubmitDisabled: isSubmitDisabled,
            isSubmitting: isSubmitting,
            isResponding: isResponding,
            isCancelling: isCancelling,
            isInterruptDisabled: isInterruptDisabled,
            isAttachmentInputDisabled: isAttachmentInputDisabled,
            trailingAccessory: EmptyView.init,
            onSubmit: onSubmit,
            onStop: onStop,
            onRemoveImageAttachment: onRemoveImageAttachment,
            onRetryImageAttachment: onRetryImageAttachment,
            onPhotosSelected: onPhotosSelected,
            onCameraImageCaptured: onCameraImageCaptured
        )
    }
}

private struct ImageAttachmentFailure {
    let id: UUID
    let message: String
    let canRetry: Bool
}

private extension PromptComposerView {
    func showNewFailureHUDs(in attachments: [PromptComposerImageAttachmentPreview]) {
        let failures = attachments.compactMap { attachment -> ImageAttachmentFailure? in
            guard let message = attachment.status.failureMessage else {
                return nil
            }
            return ImageAttachmentFailure(
                id: attachment.id,
                message: message,
                canRetry: attachment.canRetry
            )
        }

        let failedIDs = Set(failures.map(\.id))
        notifiedFailedAttachmentIDs.formIntersection(failedIDs)

        for failure in failures where !notifiedFailedAttachmentIDs.contains(failure.id) {
            showToast?(
                title: Text("Image upload failed"),
                verbatimSubtitle: failure.canRetry ? "Tap the red image to retry." : failure.message,
                icon: Image(systemName: "exclamationmark.circle.fill")
            )
            haptics.play(.error)
            notifiedFailedAttachmentIDs.insert(failure.id)
        }
    }

    func showImageSelectionErrorHUDIfNeeded(_ message: String?) {
        guard let message, !message.isEmpty, !imageAttachments.contains(where: { $0.status.isFailed }) else {
            return
        }

        showToast?(
            title: Text(verbatim: message),
            icon: Image(systemName: "exclamationmark.circle.fill")
        )
    }
}

private extension View {
    @ViewBuilder
    func promptComposerGlassBackground<S: Shape>(
        in shape: S,
        fallbackColor: Color,
        interactive: Bool = true,
        isGlassEnabled: Bool = true
    ) -> some View {
        if #available(iOS 26.0, *) {
            let effect: Glass = {
                var glass = isGlassEnabled ? Glass.regular : Glass.identity
                if isGlassEnabled, interactive {
                    glass = glass.interactive()
                }
                return glass
            }()
            glassEffect(effect, in: shape)
        } else {
            background(shape.fill(fallbackColor))
        }
    }
}
