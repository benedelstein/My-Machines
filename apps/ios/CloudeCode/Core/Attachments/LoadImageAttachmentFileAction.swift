import API
import ImageIO
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Upload-ready image data plus the small preview image used by the composer UI.
struct LoadedImageAttachmentFile {
    let file: AttachmentUploadFile
    let previewImage: UIImage?
}

/// Converts picker and camera images into uploadable attachment files.
actor LoadImageAttachmentFileAction {
    private enum Constants {
        static let previewMaxPixelSize: Int = 320
        static let uploadMaxPixelSize: Int = 2_000
        static let uploadJPEGCompressionQuality: Double = 0.75
    }

    /// Encodes a camera image as a bounded JPEG upload and separate preview thumbnail.
    func callAsFunction(from image: UIImage) async -> LoadedImageAttachmentFile? {
        guard let uploadImage = image.preparingThumbnail(of: CGSize(
            width: Constants.uploadMaxPixelSize,
            height: Constants.uploadMaxPixelSize
        )),
            let data = uploadImage.jpegData(compressionQuality: Constants.uploadJPEGCompressionQuality) else {
            return nil
        }
        let file = AttachmentUploadFile(
            data: data,
            filename: "camera-\(UUID().uuidString.lowercased()).jpg",
            mediaType: "image/jpeg"
        )
        return LoadedImageAttachmentFile(
            file: file,
            previewImage: image.preparingThumbnail(of: CGSize(
                width: Constants.previewMaxPixelSize,
                height: Constants.previewMaxPixelSize
            ))
        )
    }

    /// Loads a selected Photos item as a bounded upload image and separate preview thumbnail.
    func callAsFunction(from item: PhotosPickerItem) async throws -> LoadedImageAttachmentFile? {
        // Prefer a file URL so the original encoded asset stays out of the app
        // heap while ImageIO reads and downscales from disk. The Data fallback
        // below still downscales correctly, but first materializes source bytes.
        if let transferredFile = try await item.loadTransferable(type: ImageAttachmentTransferredFile.self) {
            defer { try? FileManager.default.removeItem(at: transferredFile.url) }
            guard let imageSource = makeImageSource(from: transferredFile.url),
                  let file = uploadFile(from: imageSource) else {
                return nil
            }
            return LoadedImageAttachmentFile(
                file: file,
                previewImage: makePreviewImage(from: imageSource)
            )
        }

        // Compatibility fallback for providers that cannot vend a file URL. This
        // path still uses ImageIO downsampling, but it first loads source bytes.
        guard let data = try await item.loadTransferable(type: Data.self) else {
            return nil
        }
        guard let imageSource = makeImageSource(from: data),
              let file = uploadFile(from: imageSource) else {
            return nil
        }
        return LoadedImageAttachmentFile(
            file: file,
            previewImage: makePreviewImage(from: imageSource)
        )
    }

    private func uploadFile(from imageSource: CGImageSource) -> AttachmentUploadFile? {
        guard let encodedImage = makeUploadImageData(from: imageSource) else {
            return nil
        }
        return AttachmentUploadFile(
            data: encodedImage.data,
            filename: "image-\(UUID().uuidString.lowercased()).\(encodedImage.fileExtension)",
            mediaType: encodedImage.mediaType
        )
    }

    private func makeImageSource(from url: URL) -> CGImageSource? {
        let sourceOptions: [CFString: Any] = [
            kCGImageSourceShouldCache: false
        ]
        return CGImageSourceCreateWithURL(url as CFURL, sourceOptions as CFDictionary)
    }

    private func makeImageSource(from data: Data) -> CGImageSource? {
        let sourceOptions: [CFString: Any] = [
            kCGImageSourceShouldCache: false
        ]
        return CGImageSourceCreateWithData(data as CFData, sourceOptions as CFDictionary)
    }

    private func makePreviewImage(from imageSource: CGImageSource) -> UIImage? {
        // Preview thumbnails are only for the composer strip, so keep them much
        // smaller than the upload image and store the resulting UIImage directly.
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Constants.previewMaxPixelSize
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
            imageSource,
            0,
            thumbnailOptions as CFDictionary
        ) else {
            return nil
        }
        return UIImage(cgImage: thumbnail)
    }

    private func makeUploadImageData(from imageSource: CGImageSource) -> EncodedImageData? {
        // The API still accepts Data, but we do not upload original camera-size
        // assets. ImageIO downscales during decode, then CGImageDestination
        // encodes those bounded pixels back into uploadable JPEG/PNG bytes.
        let uploadOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Constants.uploadMaxPixelSize
        ]
        guard let uploadImage = CGImageSourceCreateThumbnailAtIndex(
            imageSource,
            0,
            uploadOptions as CFDictionary
        ) else {
            return nil
        }

        let contentType = uploadContentType(for: imageSource)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            contentType.identifier as CFString,
            1,
            nil
        ) else {
            return nil
        }

        let destinationProperties = uploadDestinationProperties(for: contentType)
        CGImageDestinationAddImage(destination, uploadImage, destinationProperties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }

        return EncodedImageData(
            data: data as Data,
            fileExtension: contentType.preferredFilenameExtension ?? "jpg",
            mediaType: contentType.preferredMIMEType ?? "image/jpeg"
        )
    }

    private func uploadContentType(for imageSource: CGImageSource) -> UTType {
        guard let sourceTypeIdentifier = CGImageSourceGetType(imageSource) as String?,
              sourceTypeIdentifier == UTType.png.identifier else {
            return .jpeg
        }
        return .png
    }

    private func uploadDestinationProperties(for contentType: UTType) -> [CFString: Any] {
        // dont compress pngs
        guard contentType != .png else {
            return [:]
        }
        return [
            kCGImageDestinationLossyCompressionQuality: Constants.uploadJPEGCompressionQuality
        ]
    }
}

private struct EncodedImageData {
    let data: Data
    let fileExtension: String
    let mediaType: String
}

private struct ImageAttachmentTransferredFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { receivedFile in
            let fileExtension = receivedFile.file.pathExtension.isEmpty
                ? "image"
                : receivedFile.file.pathExtension
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("image-\(UUID().uuidString.lowercased()).\(fileExtension)")
            try FileManager.default.copyItem(at: receivedFile.file, to: url)
            return ImageAttachmentTransferredFile(url: url)
        }
    }
}
