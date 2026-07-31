import SwiftUI

struct WorkingIndicatorView: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let isActive: Bool

    @State private var morphProgress: CGFloat = 0
    @State private var floatPulse: Bool = false
    @State private var squigglePulse: Bool = false

    var body: some View {
        HStack {
            cloud
                .frame(width: metrics.size.width, height: metrics.size.height)
                .opacity(metrics.opacity)
                .animation(.easeOut(duration: 0.35), value: isActive)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, style.gridSize / 2)
        .accessibilityElement(children: .ignore)
        .accessibilityHidden(!isActive)
        .accessibilityAddTraits(.updatesFrequently)
        .onAppear {
            updateAnimationState()
        }
        .onChange(of: isActive) { _, _ in
            updateAnimationState()
        }
    }

    private var cloud: some View {
        ZStack {
            let shape = WorkingCloudShape(morphProgress: morphProgress)

            shape
                .fill(theme.secondaryBackgroundColor)

            shape
                .stroke(
                    theme.secondaryLabelColor,
                    style: StrokeStyle(lineWidth: 1, lineCap: .round, lineJoin: .round)
                )

            ForEach(WorkingCloudSquiggleShape.Kind.allCases) { kind in
                WorkingCloudSquiggleShape(kind: kind)
                    .stroke(
                        theme.secondaryLabelColor,
                        style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round)
                    )
                    .opacity(squiggleOpacity)
                    .offset(y: squiggleOffset)
            }
        }
        .rotationEffect(.degrees(floatRotation))
        .scaleEffect(floatScale)
        .offset(y: floatOffset)
    }

    private var metrics: Metrics {
        isActive
            ? Metrics(size: CGSize(width: 38, height: 26), opacity: 1)
            : Metrics(size: CGSize(width: 24, height: 16), opacity: 1)
    }

    private var floatOffset: CGFloat {
        guard isActive else {
            return 0
        }

        return floatPulse ? -3.5 : 1.2
    }

    private var floatRotation: Double {
        guard isActive else {
            return 0
        }

        return floatPulse ? 0.55 : -0.35
    }

    private var floatScale: CGFloat {
        guard isActive else {
            return 1
        }

        return floatPulse ? 1.025 : 0.995
    }

    private var squiggleOffset: CGFloat {
        guard isActive else {
            return 0
        }

        return squigglePulse ? -1.2 : 0.3
    }

    private var squiggleOpacity: Double {
        guard isActive else {
            return 0.6
        }

        return squigglePulse ? 0.9 : 0.48
    }

    private func updateAnimationState() {
        guard isActive else {
            withAnimation(.easeOut(duration: 0.25)) {
                morphProgress = 0
                floatPulse = false
                squigglePulse = false
            }
            return
        }

        morphProgress = 0
        floatPulse = false
        squigglePulse = false

        withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
            morphProgress = 1
        }
        withAnimation(.easeInOut(duration: 1.3).repeatForever(autoreverses: true)) {
            floatPulse = true
        }
        withAnimation(.easeInOut(duration: 1.25).repeatForever(autoreverses: true)) {
            squigglePulse = true
        }
    }

    private struct Metrics {
        let size: CGSize
        let opacity: Double
    }
}

private struct WorkingCloudShape: Shape {
    var morphProgress: CGFloat

    var animatableData: CGFloat {
        get { morphProgress }
        set { morphProgress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let outline = WorkingCloudOutline.base.interpolated(
            to: .undulating,
            progress: morphProgress.clamped(to: 0...1)
        )
        var path = Path()

        path.move(to: outline.start.scaled(in: rect))
        for curve in outline.curves {
            path.addCurve(
                to: curve.end.scaled(in: rect),
                control1: curve.control1.scaled(in: rect),
                control2: curve.control2.scaled(in: rect)
            )
        }
        path.closeSubpath()
        return path
    }
}

private struct WorkingCloudSquiggleShape: Shape {
    enum Kind: CaseIterable, Identifiable {
        case left
        case center
        case right

        var id: Self {
            self
        }
    }

    let kind: Kind

    func path(in rect: CGRect) -> Path {
        let cubic = cubic
        var path = Path()
        path.move(to: cubic.start.scaled(in: rect))
        path.addCurve(
            to: cubic.end.scaled(in: rect),
            control1: cubic.control1.scaled(in: rect),
            control2: cubic.control2.scaled(in: rect)
        )
        return path
    }

    private var cubic: WorkingCloudCubic {
        switch kind {
        case .left:
            WorkingCloudCubic(
                start: CGPoint(x: 19.2, y: 25.6),
                control1: CGPoint(x: 17.2, y: 27.8),
                control2: CGPoint(x: 17, y: 30.2),
                end: CGPoint(x: 18.9, y: 32.1)
            )
        case .center:
            WorkingCloudCubic(
                start: CGPoint(x: 27.7, y: 29.7),
                control1: CGPoint(x: 30.4, y: 33.1),
                control2: CGPoint(x: 35.6, y: 33.1),
                end: CGPoint(x: 38.2, y: 29.9)
            )
        case .right:
            WorkingCloudCubic(
                start: CGPoint(x: 43.6, y: 17.4),
                control1: CGPoint(x: 46.5, y: 17.6),
                control2: CGPoint(x: 48.3, y: 19),
                end: CGPoint(x: 48.9, y: 21.4)
            )
        }
    }
}

private struct WorkingCloudOutline {
    let start: CGPoint
    let curves: [WorkingCloudCubic]

    func interpolated(to outline: WorkingCloudOutline, progress: CGFloat) -> WorkingCloudOutline {
        WorkingCloudOutline(
            start: start.interpolated(to: outline.start, progress: progress),
            curves: zip(curves, outline.curves).map { source, target in
                source.interpolated(to: target, progress: progress)
            }
        )
    }
}

private struct WorkingCloudCubic {
    let start: CGPoint
    let control1: CGPoint
    let control2: CGPoint
    let end: CGPoint

    func interpolated(to cubic: WorkingCloudCubic, progress: CGFloat) -> WorkingCloudCubic {
        WorkingCloudCubic(
            start: start.interpolated(to: cubic.start, progress: progress),
            control1: control1.interpolated(to: cubic.control1, progress: progress),
            control2: control2.interpolated(to: cubic.control2, progress: progress),
            end: end.interpolated(to: cubic.end, progress: progress)
        )
    }
}

private extension WorkingCloudOutline {
    static let base: WorkingCloudOutline = WorkingCloudOutline(
        start: CGPoint(x: 12.4, y: 30.1),
        curves: [
            WorkingCloudCubic(
                start: CGPoint(x: 12.4, y: 30.1),
                control1: CGPoint(x: 7.4, y: 29.3),
                control2: CGPoint(x: 4.9, y: 24.1),
                end: CGPoint(x: 8.4, y: 20.5)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 8.4, y: 20.5),
                control1: CGPoint(x: 7.2, y: 16.3),
                control2: CGPoint(x: 11.3, y: 12.4),
                end: CGPoint(x: 16, y: 13.4)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 16, y: 13.4),
                control1: CGPoint(x: 18.2, y: 8.2),
                control2: CGPoint(x: 25.2, y: 7),
                end: CGPoint(x: 30, y: 10.6)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 30, y: 10.6),
                control1: CGPoint(x: 34.2, y: 7.4),
                control2: CGPoint(x: 41.2, y: 8.8),
                end: CGPoint(x: 43.5, y: 13.6)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 43.5, y: 13.6),
                control1: CGPoint(x: 49.2, y: 13.8),
                control2: CGPoint(x: 55.4, y: 18.3),
                end: CGPoint(x: 54.1, y: 25.3)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 54.1, y: 25.3),
                control1: CGPoint(x: 59.8, y: 30.6),
                control2: CGPoint(x: 54.1, y: 38.3),
                end: CGPoint(x: 45.5, y: 36.8)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 45.5, y: 36.8),
                control1: CGPoint(x: 42, y: 41),
                control2: CGPoint(x: 35.1, y: 40.8),
                end: CGPoint(x: 31.4, y: 37.6)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 31.4, y: 37.6),
                control1: CGPoint(x: 26.9, y: 41.2),
                control2: CGPoint(x: 19.5, y: 40.4),
                end: CGPoint(x: 17.2, y: 35.8)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 17.2, y: 35.8),
                control1: CGPoint(x: 13.6, y: 36.2),
                control2: CGPoint(x: 10.7, y: 34),
                end: CGPoint(x: 12.4, y: 30.1)
            )
        ]
    )

    static let undulating: WorkingCloudOutline = WorkingCloudOutline(
        start: CGPoint(x: 11.6, y: 29.2),
        curves: [
            WorkingCloudCubic(
                start: CGPoint(x: 11.6, y: 29.2),
                control1: CGPoint(x: 6.8, y: 27.9),
                control2: CGPoint(x: 5.3, y: 22.3),
                end: CGPoint(x: 9, y: 19.5)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 9, y: 19.5),
                control1: CGPoint(x: 8.5, y: 15.2),
                control2: CGPoint(x: 12.8, y: 11.7),
                end: CGPoint(x: 17.1, y: 13.2)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 17.1, y: 13.2),
                control1: CGPoint(x: 20, y: 8.7),
                control2: CGPoint(x: 26.8, y: 7.6),
                end: CGPoint(x: 30.8, y: 11.1)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 30.8, y: 11.1),
                control1: CGPoint(x: 35.7, y: 8),
                control2: CGPoint(x: 41.6, y: 9.6),
                end: CGPoint(x: 44.1, y: 14.4)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 44.1, y: 14.4),
                control1: CGPoint(x: 50.8, y: 14),
                control2: CGPoint(x: 55.6, y: 19.9),
                end: CGPoint(x: 53, y: 25.9)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 53, y: 25.9),
                control1: CGPoint(x: 59.1, y: 31.7),
                control2: CGPoint(x: 52.2, y: 38.4),
                end: CGPoint(x: 44.7, y: 36.2)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 44.7, y: 36.2),
                control1: CGPoint(x: 40.5, y: 40.2),
                control2: CGPoint(x: 34.5, y: 39.8),
                end: CGPoint(x: 31, y: 36.8)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 31, y: 36.8),
                control1: CGPoint(x: 26.1, y: 40.7),
                control2: CGPoint(x: 19.6, y: 39.4),
                end: CGPoint(x: 16.8, y: 35.2)
            ),
            WorkingCloudCubic(
                start: CGPoint(x: 16.8, y: 35.2),
                control1: CGPoint(x: 12.8, y: 35.8),
                control2: CGPoint(x: 9.9, y: 33.1),
                end: CGPoint(x: 11.6, y: 29.2)
            )
        ]
    )
}

private extension CGPoint {
    func interpolated(to point: CGPoint, progress: CGFloat) -> CGPoint {
        CGPoint(
            x: x + ((point.x - x) * progress),
            y: y + ((point.y - y) * progress)
        )
    }

    func scaled(in rect: CGRect) -> CGPoint {
        CGPoint(
            x: rect.minX + (x / 64 * rect.width),
            y: rect.minY + (y / 44 * rect.height)
        )
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
