import Domain
import UIKit

final class LayoutReportingCollectionView: UICollectionView, SessionTranscriptKeyboardTransitionReporting {
    /// Called after UIKit completes this collection view's layout pass.
    var onLayoutSubviews: ((LayoutReportingCollectionView) -> Void)?
    /// Most recent keyboard transition waiting to be consumed by the transcript coordinator.
    private(set) var pendingKeyboardTransition: KeyboardTransition?
    private let keyboardTransitionObserver: KeyboardTransitionObserving
    private let obstructionInsetResolver: SessionTranscriptObstructionInsetResolver =
        SessionTranscriptObstructionInsetResolver()

    /// Creates a collection view that reports layout passes and keyboard transitions.
    init(
        frame: CGRect,
        collectionViewLayout layout: UICollectionViewLayout,
        keyboardTransitionObserver: KeyboardTransitionObserving = NotificationKeyboardTransitionObserver()
    ) {
        self.keyboardTransitionObserver = keyboardTransitionObserver
        super.init(frame: frame, collectionViewLayout: layout)
        configureKeyboardTransitionObserver()
    }

    required init?(coder: NSCoder) {
        keyboardTransitionObserver = NotificationKeyboardTransitionObserver()
        super.init(coder: coder)
        configureKeyboardTransitionObserver()
    }

    deinit {
        keyboardTransitionObserver.stop()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayoutSubviews?(self)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        obstructionInsetResolver.reset()
        updateKeyboardObservers()
    }

    /// Returns the insets needed when this view overlaps safe areas or visible navigation bars.
    func contentInsets() -> UIEdgeInsets {
        obstructionInsetResolver.contentInsets(for: self)
    }

    /// Marks the pending keyboard transition as consumed.
    func clearPendingKeyboardTransition() {
        pendingKeyboardTransition = nil
    }

    private func updateKeyboardObservers() {
        keyboardTransitionObserver.stop()
        pendingKeyboardTransition = nil

        guard window != nil else { return }

        keyboardTransitionObserver.start(in: self)
    }

    private func configureKeyboardTransitionObserver() {
        keyboardTransitionObserver.onTransition = { [weak self] transition in
            self?.handleKeyboardTransition(transition)
        }
    }

    private func handleKeyboardTransition(_ transition: KeyboardTransition) {
        pendingKeyboardTransition = transition
        setNeedsLayout()
    }

    private var distanceFromBottom: CGFloat {
        let visibleBottomY = contentOffset.y + bounds.height - adjustedContentInset.bottom
        return contentSize.height - visibleBottomY
    }

    private func format(_ value: CGFloat) -> String {
        String(format: "%.2f", Double(value))
    }
}
