import Combine
import SwiftUI
import UIKit

struct ToastContainerView<Content: View>: View {
    @Environment(\.style) private var style: Style
    @Environment(\.theme) private var theme: Theme

    let content: () -> Content

    private let cornerRadius: CGFloat = 24
    private let verticalInset: CGFloat = 10
    private let horizontalInset: CGFloat = 16

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)

        content()
            .padding(.horizontal, horizontalInset)
            .padding(.vertical, verticalInset)
            .overlay {
                shape
                    .stroke(Color.white.opacity(0.5), lineWidth: 0.5)
            }
            .toastGlassBackground(in: shape)
            .contentShape(shape)
            .padding(.horizontal, style.horizontalPadding)
    }
}

struct ToastDefaultContentView: View {
    @Environment(\.style) private var style: Style
    @Environment(\.theme) private var theme: Theme

    let title: Text
    var subtitle: Text?
    var icon: Image?

    var body: some View {
        HStack(spacing: 12) {
            if let icon {
                icon
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.accentBlue)
            }

            VStack(alignment: icon == nil ? .center : .leading, spacing: 2) {
                title
                    .font(style.calloutFont.weight(.semibold))
                    .foregroundStyle(theme.labelColor)

                if let subtitle {
                    subtitle
                        .font(style.footnoteFont)
                        .foregroundStyle(theme.secondaryLabelColor)
                        .multilineTextAlignment(icon == nil ? .center : .leading)
                }
            }
        }
    }
}

struct ToastSceneView: View {
    var body: some View {
        EmptyView()
    }
}

final class ToastHudViewModel: ObservableObject {
    @Published var showToast: Bool = false
    @Published var dragOffset: CGFloat = .zero
    var proposedHeight: CGFloat?
    var onDismiss: (() -> Void)?
}

private struct ToastHudContainerView<Content: View>: View {
    @StateObject private var toastViewModel: ToastHudViewModel
    @State private var timer: Publishers.Autoconnect<Timer.TimerPublisher>
    @GestureState private var isDragging: Bool = false

    let config: ToastConfig
    let content: () -> Content

    init(
        toastViewModel: ToastHudViewModel,
        config: ToastConfig,
        content: @escaping () -> Content
    ) {
        self._toastViewModel = StateObject(wrappedValue: toastViewModel)
        self.config = config
        self.content = content
        self._timer = State(
            wrappedValue: Timer.publish(every: config.duration, on: .main, in: .common)
                .autoconnect()
        )
    }

    private var viewOffset: CGFloat {
        if toastViewModel.showToast {
            return toastViewModel.dragOffset
        }

        return -max(toastViewModel.proposedHeight ?? 100, 100)
    }

    private var opacity: CGFloat {
        config.dimTransition && !toastViewModel.showToast ? 0 : 1
    }

    var body: some View {
        VStack {
            content()
                .padding(config.padding)
                .opacity(opacity)
                .offset(y: viewOffset)
                .animation(.spring(response: 0.15, dampingFraction: 0.85), value: toastViewModel.dragOffset)
                .animation(
                    toastViewModel.showToast ? config.insertionAnimation : config.removalAnimation,
                    value: toastViewModel.showToast
                )
                .allowsHitTesting(toastViewModel.showToast)
                .onTapGesture {
                    dismiss()
                }
                .highPriorityGesture(dismissDragGesture)
        }
        .ignoresSafeArea(config.ignoresSafeArea ? [.all] : [])
        .onReceive(timer) { _ in
            guard !isDragging, toastViewModel.showToast else {
                return
            }
            dismiss()
        }
        .onChange(of: isDragging) { _, newValue in
            if newValue {
                timer.upstream.connect().cancel()
            } else {
                timer = Timer.publish(every: config.duration, on: .main, in: .common).autoconnect()
            }
        }
        .onAppear {
            toastViewModel.showToast = true
        }
    }

    private var dismissDragGesture: some Gesture {
        DragGesture()
            .updating($isDragging) { _, state, _ in
                state = true
            }
            .onChanged { value in
                if value.translation.height > 0 {
                    toastViewModel.dragOffset = rubberBand(
                        offset: abs(value.translation.height),
                        dimension: 100,
                        resistance: 0.5
                    )
                } else {
                    toastViewModel.dragOffset = value.translation.height
                }
            }
            .onEnded { value in
                if value.predictedEndTranslation.height < -50 {
                    dismiss()
                    toastViewModel.dragOffset = 0
                } else {
                    withAnimation(.spring()) {
                        toastViewModel.dragOffset = 0
                    }
                }
            }
    }

    private func dismiss() {
        if #available(iOS 17.0, *) {
            withAnimation(config.removalAnimation) {
                toastViewModel.showToast = false
            } completion: {
                finishDismiss()
            }
        } else {
            withAnimation(config.removalAnimation) {
                toastViewModel.showToast = false
            }
            finishDismiss()
        }
    }

    private func finishDismiss() {
        toastViewModel.onDismiss?()
        timer.upstream.connect().cancel()
    }
}

extension UIWindow {
    func showToast<Content: View>(
        _ config: ToastConfig,
        @ViewBuilder content: @escaping () -> Content
    ) {
        let toastViewModel = ToastHudViewModel()
        let swiftUIView = ToastHudContainerView(
            toastViewModel: toastViewModel,
            config: config,
            content: content
        )
        .themedRoot()

        let toastViewController = UIHostingController(rootView: swiftUIView)
        guard let toastView = toastViewController.view else {
            return
        }

        toastViewController.sizingOptions = .intrinsicContentSize
        toastView.translatesAutoresizingMaskIntoConstraints = false
        toastView.backgroundColor = .clear
        toastViewModel.proposedHeight = toastView.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize).height

        addSubview(toastView)

        toastViewModel.onDismiss = { [weak toastView, weak toastViewController] in
            toastView?.isUserInteractionEnabled = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                toastViewController?.removeFromParent()
                toastView?.removeFromSuperview()
            }
        }

        NSLayoutConstraint.activate([
            toastView.topAnchor.constraint(equalTo: topAnchor),
            toastView.centerXAnchor.constraint(equalTo: centerXAnchor),
            toastView.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor),
            toastView.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor)
        ])
    }
}

private func rubberBand(offset: CGFloat, dimension: CGFloat, resistance: CGFloat) -> CGFloat {
    (1.0 - (1.0 / ((offset * resistance / dimension) + 1.0))) * dimension
}

private extension View {
    @ViewBuilder
    func toastGlassBackground<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular.interactive(), in: shape)
        } else {
            background(
                shape
                    .fill(.ultraThinMaterial)
                    .shadow(color: Color.black.opacity(0.2), radius: 8)
            )
        }
    }
}
