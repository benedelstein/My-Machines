import Domain
import SwiftUI

struct TurnWorkHeaderView: View {
    @Environment(\.theme) private var theme: Theme
    @Environment(\.style) private var style: Style

    let expanded: Bool
    let startedAt: Date?
    let endedAt: Date?
    let isStreaming: Bool
    let collapsible: Bool
    let onToggle: () -> Void

    var body: some View {
        if collapsible {
            Button(action: onToggle) {
                content
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
        } else {
            content
                .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private var content: some View {
        HStack(spacing: style.gridSize) {
            label
                .styledFont(.caption)
                .foregroundStyle(theme.secondaryLabelColor)

            if collapsible {
                Image(systemName: "chevron.right")
                    .font(.body(9))
                    .foregroundStyle(theme.tertiaryLabelColor)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
        }
        .contentShape(.rect)
    }

    @ViewBuilder
    private var label: some View {
        if let startedAt, let endedAt {
            Text("Worked for \(Self.durationString(from: startedAt, to: endedAt))")
        } else if let startedAt, isStreaming {
            WorkingDurationLabel(startedAt: startedAt)
        } else {
            Text(isStreaming ? "Working" : "Worked")
        }
    }

    private static func durationString(from startDate: Date, to endDate: Date) -> String {
        let totalSeconds = max(0, Int(endDate.timeIntervalSince(startDate)))
        return durationFormatter.string(from: TimeInterval(totalSeconds)) ?? "\(totalSeconds)s"
    }

    private static let durationFormatter: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.hour, .minute, .second]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        formatter.zeroFormattingBehavior = .dropAll
        return formatter
    }()
}

private struct WorkingDurationLabel: View {
    private let durationTickAnimation: Animation = Animation.easeInOut(duration: 0.2)

    let startedAt: Date

    var body: some View {
        TimelineView(.periodic(from: startedAt, by: 1)) { context in
            let totalSeconds = max(0, Int(context.date.timeIntervalSince(startedAt)))
            Text("Working for \(Self.durationString(seconds: totalSeconds))")
                .contentTransition(.numericText(value: Double(totalSeconds)))
                .animation(durationTickAnimation, value: totalSeconds)
        }
    }

    private static func durationString(seconds: Int) -> String {
        durationFormatter.string(from: TimeInterval(seconds)) ?? "\(seconds)s"
    }

    private static let durationFormatter: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.hour, .minute, .second]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        formatter.zeroFormattingBehavior = .dropAll
        return formatter
    }()
}
