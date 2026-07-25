import PhotosUI
import SwiftUI
import UIKit

extension PromptComposerView {
    struct InlinePhotoPickerContent: View {
        @Environment(\.composerStyle) private var composerStyle: ComposerStyle
        @Environment(\.hapticFeedbackPlayer) var haptics
        @Environment(\.theme) private var theme: Theme
        @Environment(\.style) private var style: Style

        let isVisible: Bool
        let remainingImageSlots: Int
        let onDismiss: () -> Void
        let onShowAllPhotos: () -> Void
        let onPhotosSelected: ([PhotosPickerItem]) -> Void

        // Inline selection is staged until confirmation; sheet selection commits when PhotosUI finishes.
        @State private var selectedPhotoItems: [PhotosPickerItem] = []
        @State private var hasStagedSelection: Bool = false

        var body: some View {
            ZStack(alignment: .bottom) {
                theme.secondaryBackgroundColor // opaque bg
                    .zIndex(0)
                // conditionally show the picker, but keep the bottom controls
                // visible so they dont fly up from bottom.
                // they appear in place
                if isVisible {
                    PhotosPicker(
                        selection: $selectedPhotoItems,
                        maxSelectionCount: max(1, remainingImageSlots),
                        selectionBehavior: .continuous,
                        matching: .images,
                        preferredItemEncoding: .current
                    ) {
                        Color.clear
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .contentShape(Rectangle())
                    }
                    .photosPickerStyle(.inline)
                    .photosPickerAccessoryVisibility(.hidden)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .zIndex(1)
                }

                controls
                    .padding(composerStyle.contentInset)
                    .zIndex(2)
            }
            .allowsHitTesting(isVisible)
            .sensoryFeedback(.selection, trigger: selectedPhotoItems)
            .onChange(of: selectedPhotoItems) {
                setStagedSelectionVisible(!$1.isEmpty)
            }
            .onChange(of: isVisible) { _, newValue in
                guard !newValue else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    withAnimation(nil) {
                        resetSelection()
                    }
                }
            }
        }

        private var controls: some View {
            HStack {
                Button {
                    onDismiss()
                } label: {
                    xmarkIcon
                        .foregroundStyle(theme.labelColor)
                        .glassBackground(in: .circle)
                }
                .buttonBorderShape(.circle)

                Spacer()

                // fixme - there's a weird fly-up animation
                // the first time you tap confirm on a session.
                // this button should remain fixed in its spot.
                Button {
                    haptics.play(.light)
                    if hasStagedSelection {
                        confirmSelection()
                    } else {
                        onShowAllPhotos()
                    }
                } label: {
                    confirmationLabel
                        .padding(.horizontal, 12)
                        .frame(height: composerStyle.bottomButtonSize)
                        .contentShape(.capsule)
                        // glassButtonStyle with diff tint doesnt animate well.
                        .glassBackground(in: .capsule, tint: hasStagedSelection ? Color.blue : nil)
                }
                .buttonStyle(.plain)
                .animation(style.springAnimation, value: hasStagedSelection)
            }
        }

        private var xmarkIcon: some View {
            Image(systemName: "xmark")
                .font(.system(size: 16, weight: .semibold))
                .frame(width: composerStyle.bottomButtonSize, height: composerStyle.bottomButtonSize)
        }

        @ViewBuilder
        private var confirmationLabel: some View {
            Text(hasStagedSelection ? "Select photos" : "Show all photos")
                .font(.semibold(12))
        }

        private func confirmSelection() {
            let items = selectedPhotoItems
            guard !items.isEmpty else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                // delay for animation
                withAnimation(nil) {
                    resetSelection()
                }
            }
            onPhotosSelected(items)
        }

        private func resetSelection() {
            selectedPhotoItems = []
            hasStagedSelection = false
        }

        private func setStagedSelectionVisible(_ isVisible: Bool) {
            guard hasStagedSelection != isVisible else { return }
            withAnimation(style.springAnimation) {
                hasStagedSelection = isVisible
            }
        }
    }
}
