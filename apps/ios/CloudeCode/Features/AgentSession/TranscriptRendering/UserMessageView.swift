//
//  UserMessageView.swift
//  CloudeCode
//
//  Created by Ben Edelstein on 6/14/26.
//
import Domain
import SwiftUI
import UIKit

struct UserMessageView: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style
    @Environment(SessionTranscriptRowViewModel.self) private var rowViewModel: SessionTranscriptRowViewModel

    private enum Constants {
        static let collapsedLineLimit: Int = 10
        static let approximateCollapsedCharacterLimit: Int = 400
    }

    let message: SessionMessage

    private var images: [SessionImageInfo] {
        message.parts.enumerated().compactMap { index, part in
            guard case .file(let payload) = part,
                  payload.mediaType.hasPrefix("image/"),
                  let url = Self.resolveAttachmentURL(payload.url) else {
                return nil
            }

            return SessionImageInfo(
                id: "\(message.id)-image-\(index)",
                url: url,
                width: payload.width,
                height: payload.height,
                accessibilityLabel: payload.filename ?? "Uploaded image"
            )
        }
    }

    var body: some View {
        HStack(alignment: .top) {
            Spacer(minLength: style.gridSize * 5)
            VStack(alignment: .trailing, spacing: style.gridSize / 2) {
                imageViews
                if !message.text.isEmpty {
                    messageText
                }
            }
        }
        .transition(style.fadeTransition)
    }

    private var messageText: some View {
        VStack(alignment: .leading, spacing: style.gridSize / 2) {
            Text(verbatim: message.text)
                .styledFont(.subheadline)
                .foregroundStyle(theme.labelColor)
                .textSelection(.enabled)
                .lineLimit(rowViewModel.userMessageExpanded ? nil : Constants.collapsedLineLimit)

            if showsExpansionControl {
                Button(
                    rowViewModel.userMessageExpanded ? "Collapse" : "Expand",
                    action: toggleMessageExpansion
                )
                    .styledFont(.caption)
                    .foregroundStyle(theme.secondaryLabelColor)
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(userMessageShape.fill(theme.secondaryBackgroundColor))
    }

    private var showsExpansionControl: Bool {
        // Measuring an unbounded hidden Text to detect truncation would recreate
        // the initial-load cost this collapsed presentation is avoiding.
        message.text.utf16.count > Constants.approximateCollapsedCharacterLimit
            || message.text.lazy.filter(\.isNewline).count >= Constants.collapsedLineLimit
    }

    private func toggleMessageExpansion() {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            rowViewModel.userMessageExpanded.toggle()
        }
    }

    @ViewBuilder
    private var imageViews: some View {
        if !images.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: style.gridSize) {
                    ForEach(images) { image in
                        userImageView(image)
                    }
                }
            }
            .defaultScrollAnchor(.trailing)
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
        }
    }

    private func userImageView(_ userImage: SessionImageInfo) -> some View {
        UserMessageRemoteImage(
            image: userImage,
            height: style.gridSize * 15
        )
    }

    private static func resolveAttachmentURL(_ rawURL: String) -> URL? {
        if let url = URL(string: rawURL), url.scheme != nil {
            return url.scheme == "blob" ? nil : url
        }

        guard rawURL.hasPrefix("/") else {
            return nil
        }

        guard let string = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String,
              let baseURL = URL(string: string),
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: true) else {
            return nil
        }

        components.path = rawURL
        return components.url
    }

    private var userMessageShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
    }
}

private struct UserMessageRemoteImage: View {
    private enum Constants {
        static let maxImageWidth: CGFloat = 260
    }

    @Environment(\.fetchImageAction) private var fetchImageAction: FetchImageAction
    @Environment(\.openAgentSessionImage) private var openImage: OpenAgentSessionImageAction
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let image: SessionImageInfo
    let height: CGFloat

    @State private var uiImage: UIImage?
    @State private var didFail: Bool = false

    var body: some View {
        content
            // future optimization - use nuke image cache
            .task(id: image.url) {
                await loadImage()
            }
    }

    @ViewBuilder
    private var content: some View {
        if let uiImage {
            // todo add nuke image cache
            Button {
                openImage(image)
            } label: {
                let size = displaySize(fallbackSize: uiImage.size)
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
                    .frame(width: size.width, height: size.height)
                    .clipShape(imageShape)
                    .overlay {
                        imageShape.stroke(theme.outlineColor, lineWidth: style.outlineThickness)
                    }
                    .contentShape(imageShape)
                    .accessibilityLabel(image.accessibilityLabel)
                    .accessibilityAddTraits(.isButton)
            }
            .buttonStyle(.bounce)
        } else if didFail {
            imageFailureView
        } else {
            imagePlaceholder
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

    private var imageShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
    }

    private var imagePlaceholder: some View {
        let size = displaySize()
        return ProgressView()
            .frame(width: size.width, height: size.height)
            .background(imageShape.fill(theme.loadingBackgroundColor))
    }

    private var imageFailureView: some View {
        let size = displaySize()
        return Image(systemName: "exclamationmark.triangle")
            .foregroundStyle(theme.secondaryLabelColor)
            .frame(width: size.width, height: size.height)
            .background(imageShape.fill(theme.loadingBackgroundColor))
            .overlay {
                imageShape.stroke(theme.outlineColor, lineWidth: style.outlineThickness)
            }
            .accessibilityLabel(Text(verbatim: "Image failed to load"))
    }

    private func displaySize(fallbackSize: CGSize? = nil) -> CGSize {
        let pixelWidth = image.width.map(CGFloat.init) ?? fallbackSize?.width ?? 0
        let pixelHeight = image.height.map(CGFloat.init) ?? fallbackSize?.height ?? 0
        guard pixelWidth > 0, pixelHeight > 0 else {
            return CGSize(width: height, height: height)
        }

        let displayWidth = min(height * pixelWidth / pixelHeight, Constants.maxImageWidth)
        return CGSize(width: displayWidth, height: displayWidth * pixelHeight / pixelWidth)
    }
}
