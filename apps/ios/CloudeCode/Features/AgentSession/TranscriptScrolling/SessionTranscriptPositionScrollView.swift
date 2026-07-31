import SwiftUI
import Domain
@_spi(Advanced) import SwiftUIIntrospect
import Combine

struct SessionTranscriptPositionScrollView<Row: View>: View {
    @State private var scrollPosition: ScrollPosition = ScrollPosition(idType: String.self, edge: .bottom)
    @State private var scrollController: ScrollController = ScrollController()
    @State private var showScrollToBottom: Bool = false
    @State private var isScrollingToBottom: Bool = false

    let items: [SessionTranscriptItem]
    let keyboardDismissPadding: CGFloat
    let rowSpacing: CGFloat
    let contentPadding: CGFloat
    @State private var show: Bool = false
    @ViewBuilder let rowContent: (SessionTranscriptItem) -> Row

    var body: some View {
        ScrollView {
            VStack {
                // regular vstack uses more memory but has more deterministic scrolling.
                // lazy vstack causes the scroll cursor to go wonky.
                LazyVStack(alignment: .leading, spacing: rowSpacing) {
                    ForEach(items) { item in
                        rowContent(item)
                            .id(item.id)
                    }
                }
                Color.clear.frame(height: 0).id("bottom")
            }
            // .scrollTargetLayout() // not needed?
            .padding(.vertical, contentPadding)
        }
        .overlay(alignment: .bottom) {
            VStack(spacing: 0) {
                if showScrollToBottom {
                    SessionTranscriptScrollToBottomButton {
                        isScrollingToBottom = true
                        showScrollToBottom = false
                        withAnimation(.easeInOut) {
                            scrollToBottom()
                        } completion: {
                            isScrollingToBottom = false
                        }
                    }
                }
                Color.clear
                    .frame(height: 16)
                    .allowsHitTesting(false)
            }
        }
        .opacity(show ? 1 : 0)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.top, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollPosition($scrollPosition, anchor: .bottom)
//        .animation(.default, value: items)
        .scrollDismissesKeyboard(.interactively)
        .introspect(.scrollView, on: .iOS(.v18...)) { scrollView in
            scrollController.update(with: scrollView)
            scrollController.updateKeyboardDismissPadding(keyboardDismissPadding)
            scrollView.contentAlignmentPoint = .init(x: 0.5, y: 0)
        }
        .onReceive(scrollController.$contentOffset) {
            guard let offset = $0 else { return }
            guard let scrollView = scrollController.scrollView else { return }
            guard let contentHeight = scrollController.contentSize?.height else { return }

            let visibleBottomY = offset.y
                + scrollView.bounds.height
                - scrollView.adjustedContentInset.bottom
            let distanceFromBottom = max(0, contentHeight - visibleBottomY)
            let shouldShowScrollToBottom = distanceFromBottom > SessionTranscriptScrollMetrics.bottomProximityThreshold
                && !isScrollingToBottom

            if showScrollToBottom != shouldShowScrollToBottom {
                showScrollToBottom = shouldShowScrollToBottom
            }
        }
        .task {
            scrollToBottom()
            do {
                // wait for any layout shift.
                try await Task.sleep(nanoseconds: 100_000)
                scrollToBottom()
                show = true
            } catch {
            }
        }
        .onChange(of: keyboardDismissPadding) {
            scrollController.updateKeyboardDismissPadding($1)
            scrollToBottom()
        }
    }

    private func scrollToBottom() {
        scrollPosition.scrollTo(edge: .bottom)
    }
}
