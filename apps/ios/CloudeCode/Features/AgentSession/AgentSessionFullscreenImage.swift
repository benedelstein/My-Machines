import SwiftUI
import UIKit

struct SessionImageInfo: Identifiable, Equatable {
    let id: String
    let url: URL
    let width: Int?
    let height: Int?
    let accessibilityLabel: String

    func displaySize(maxHeight: CGFloat, maxWidth: CGFloat) -> CGSize {
        guard let width, let height, width > 0, height > 0 else {
            return CGSize(width: maxHeight, height: maxHeight)
        }

        let aspectWidth = maxHeight * CGFloat(width) / CGFloat(height)
        let displayWidth = min(aspectWidth, maxWidth)
        let displayHeight = displayWidth * CGFloat(height) / CGFloat(width)
        return CGSize(width: displayWidth, height: displayHeight)
    }
}

struct OpenAgentSessionImageAction: Equatable {
    // needed for view updates optimization
    static func == (lhs: OpenAgentSessionImageAction, rhs: OpenAgentSessionImageAction) -> Bool {
        true
    }

    private let action: (SessionImageInfo) -> Void

    init(action: @escaping (SessionImageInfo) -> Void = { _ in }) {
        self.action = action
    }

    func callAsFunction(_ image: SessionImageInfo) {
        action(image)
    }
}

extension EnvironmentValues {
    @Entry
    var openAgentSessionImage: OpenAgentSessionImageAction = .init()
}

extension AgentSessionView {
    struct FullscreenImageView: View {
        private let dismissDragThreshold: CGFloat = 140
        private let backgroundFadeDistance: CGFloat = 280
        private let dismissCompletionDuration: TimeInterval = 0.2

        @Environment(\.dismiss) private var dismiss: DismissAction
        @Environment(\.fetchImageAction) private var fetchImageAction: FetchImageAction

        let image: SessionImageInfo

        @State private var uiImage: UIImage?
        @State private var didFail: Bool = false
        @State private var dismissDragOffset: CGSize = .zero
        @State private var isCompletingDragDismissal: Bool = false
        @State private var isChromeHidden: Bool = false

        var body: some View {
            NavigationStack {
                content
            }
        }

        var content: some View {
            ZStack(alignment: .topTrailing) {
                Color.black.opacity(backgroundOpacity)
                    .ignoresSafeArea()

                imageContent
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .offset(dismissDragOffset)
            }
            .ignoresSafeArea(.container, edges: .all)
            .toolbar {
                ToolbarCloseButton {
                    dismiss()
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if let uiImage {
                            presentShareSheet(activityItems: [uiImage])
                        }
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .disabled(uiImage == nil)
                    .accessibilityLabel("Share image")
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarVisibility(isCompletingDragDismissal || isChromeHidden ? .hidden : .visible, for: .navigationBar)
            .task(id: image.url) {
                await loadImage()
            }
            .presentationBackground(.clear)
            .background(Color.clear)
            .statusBarHidden(true)
        }

        @ViewBuilder
        private var imageContent: some View {
            if let uiImage {
                ZoomableImageView(
                    image: uiImage,
                    accessibilityLabel: image.accessibilityLabel,
                    dragConfiguration: ZoomableImageDragConfiguration(
                        onChanged: handleDragChanged,
                        onEnded: handleDragEnded,
                        onCancelled: resetDismissDrag
                    ),
                    onZoomedStateChanged: handleZoomedStateChanged,
                    onSingleTap: handleImageTap
                )
                .accessibilityLabel(image.accessibilityLabel)
            } else if didFail {
                ErrorStateView(title: "Image failed to load") {
                    Image(systemName: "photo")
                }
                .environment(\.theme, .dark)
            } else {
                ProgressView()
                    .tint(.white)
            }
        }

        private func loadImage() async {
            didFail = false
            uiImage = nil

            do {
                let data = try await fetchImageAction(image.url)
                guard let loadedImage = UIImage(data: data) else {
                    didFail = true
                    return
                }
                uiImage = loadedImage
            } catch {
                didFail = true
            }
        }

        private var backgroundOpacity: Double {
            guard !isCompletingDragDismissal else {
                return 0
            }

            let progress = min(max(dismissDragOffset.height, 0) / backgroundFadeDistance, 1)
            return Double(1 - (progress * 0.65))
        }

        private func handleDragChanged(_ translation: CGSize) {
            guard !isCompletingDragDismissal else {
                return
            }

            dismissDragOffset = translation
        }

        private func handleDragEnded(_ translation: CGSize, predictedEndTranslation: CGSize) {
            guard translation.height > dismissDragThreshold
                || predictedEndTranslation.height > dismissDragThreshold else {
                resetDismissDrag()
                return
            }

            let targetTranslation = dismissalTargetTranslation(
                translation: translation,
                predictedEndTranslation: predictedEndTranslation
            )

            withAnimation(.easeOut(duration: dismissCompletionDuration)) {
                dismissDragOffset = targetTranslation
                isCompletingDragDismissal = true
            }

            Task {
                try? await Task.sleep(nanoseconds: UInt64(dismissCompletionDuration * 1_000_000_000))
                await MainActor.run {
                    dismiss()
                }
            }
        }

        private func dismissalTargetTranslation(translation: CGSize, predictedEndTranslation: CGSize) -> CGSize {
            guard predictedEndTranslation.height > translation.height else {
                return translation
            }

            return predictedEndTranslation
        }

        private func handleZoomedStateChanged(_ isZoomed: Bool) {
            withAnimation(.easeInOut(duration: 0.2)) {
                isChromeHidden = isZoomed
            }
        }

        private func handleImageTap() {
            withAnimation(.easeInOut(duration: 0.2)) {
                isChromeHidden.toggle()
            }
        }

        private func resetDismissDrag() {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) {
                dismissDragOffset = .zero
                isCompletingDragDismissal = false
            }
        }
    }
}
