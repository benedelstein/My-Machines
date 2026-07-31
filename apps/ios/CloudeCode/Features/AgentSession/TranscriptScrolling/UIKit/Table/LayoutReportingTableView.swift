import Domain
import UIKit

final class LayoutReportingTableView: UITableView, SessionTranscriptKeyboardTransitionReporting {
    /// Called after UIKit completes this table view's layout pass.
    var onLayoutSubviews: ((LayoutReportingTableView) -> Void)?
    /// Most recent keyboard transition waiting to be consumed by the transcript coordinator.
    private(set) var pendingKeyboardTransition: KeyboardTransition?
    private let keyboardTransitionObserver: KeyboardTransitionObserving
    private let obstructionInsetResolver: SessionTranscriptObstructionInsetResolver =
        SessionTranscriptObstructionInsetResolver()

    /// Creates a table view that reports layout passes and keyboard transitions.
    init(
        frame: CGRect,
        style: UITableView.Style,
        keyboardTransitionObserver: KeyboardTransitionObserving = NotificationKeyboardTransitionObserver()
    ) {
        self.keyboardTransitionObserver = keyboardTransitionObserver
        super.init(frame: frame, style: style)
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

    /// Returns manual insets for the safe areas and navigation bars this table intentionally overlaps.
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
        // Layout consumes this later so offset updates can use the keyboard's timing.
        pendingKeyboardTransition = transition
        setNeedsLayout()
    }
}
