import SwiftUI

enum SessionTranscriptScrollDestination: Equatable {
    case top
    case bottom
    case message(id: String)
    case item(id: String)
}

enum SessionTranscriptScrollAlignment: Equatable {
    case top
    case center
    case bottom
}

struct SessionTranscriptScrollRequest: Equatable {
    let id: Int
    let destination: SessionTranscriptScrollDestination
    let alignment: SessionTranscriptScrollAlignment
    let animated: Bool
}

@Observable
final class SessionTranscriptScrollCoordinator {
    var showsScrollToBottom: Bool = false
    private(set) var scrollRequest: SessionTranscriptScrollRequest?
    private(set) var isScrollingToBottom: Bool = false
    private var nextScrollRequestID: Int = 0

    func scroll(
        to destination: SessionTranscriptScrollDestination,
        alignment: SessionTranscriptScrollAlignment = .center,
        animated: Bool = true
    ) {
        nextScrollRequestID += 1
        scrollRequest = SessionTranscriptScrollRequest(
            id: nextScrollRequestID,
            destination: destination,
            alignment: alignment,
            animated: animated
        )

        if destination == .bottom {
            isScrollingToBottom = true
            showsScrollToBottom = false
        } else {
            isScrollingToBottom = false
        }
    }

    func requestScrollToBottom() {
        scroll(to: .bottom, alignment: .bottom)
    }

    func updateDistanceFromBottom(_ distance: CGFloat) {
        let shouldShowScrollToBottom = distance > SessionTranscriptScrollMetrics.bottomProximityThreshold
            && !isScrollingToBottom
        guard showsScrollToBottom != shouldShowScrollToBottom else { return }

        showsScrollToBottom = shouldShowScrollToBottom
    }

    func finishScrollToBottom() {
        isScrollingToBottom = false
    }
}
