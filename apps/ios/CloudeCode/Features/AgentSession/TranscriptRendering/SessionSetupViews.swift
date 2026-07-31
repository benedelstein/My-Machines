import Domain
import SwiftUI

extension AgentSessionView {
    struct SetupRunView: View {
        @Environment(\.style) private var style: Style

        let state: SessionTranscriptSetupRun
        let onToggle: () -> Void

        var body: some View {
            VStack(alignment: .leading, spacing: style.gridSize) {
                Header(
                    state: state,
                    onToggle: onToggle
                )

                if case .run(let run, let isExpanded) = state, isExpanded {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(run.tasks) { task in
                            TaskRow(task: task)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        private struct Header: View {
            @Environment(\.theme) private var theme: Theme
            @Environment(\.style) private var style: Style

            let state: SessionTranscriptSetupRun
            let onToggle: () -> Void

            var body: some View {
                Button(action: onToggle) {
                    HStack(spacing: style.gridSize) {
                        Text(title)
                            .styledFont(.footnote)
                            .foregroundStyle(theme.secondaryLabelColor)

                        Image(systemName: "chevron.right")
                            .font(.body(9))
                            .foregroundStyle(theme.tertiaryLabelColor)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(isPlaceholder)
                .accessibilityLabel(title)
                .accessibilityValue(accessibilityValue)
            }

            private var title: String {
                guard case .run(let run, _) = state else {
                    return "Session initialization"
                }
                switch run.status {
                case .running:
                    return "Initializing session"
                case .failed:
                    return "Initialization failed"
                case .completed:
                    return hasWarnings ? "Initialized with warnings" : "Initialized session"
                case .unknown:
                    return "Session initialization"
                }
            }

            private var hasWarnings: Bool {
                guard case .run(let run, _) = state else {
                    return false
                }
                return run.tasks.contains { $0.status == .failed }
            }

            private var isExpanded: Bool {
                guard case .run(_, let isExpanded) = state else {
                    return false
                }
                return isExpanded
            }

            private var isPlaceholder: Bool {
                if case .placeholder = state {
                    return true
                }
                return false
            }

            private var accessibilityValue: String {
                if isPlaceholder {
                    return "Loading"
                }
                return isExpanded ? "Expanded" : "Collapsed"
            }
        }

        private struct TaskRow: View {
            @Environment(\.theme) private var theme: Theme
            @Environment(\.style) private var style: Style

            let task: SessionClientState.SessionSetupTask

            var body: some View {
                HStack(alignment: .top, spacing: style.gridSize) {
                    statusIcon
                        .frame(width: 16, height: 16)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: style.gridSize / 2) {
                        Text(label)
                            .styledFont(.footnote)
                            .foregroundStyle(theme.secondaryLabelColor)

                        if let error = task.error, !error.isEmpty {
                            Text(verbatim: error)
                                .styledFont(.caption)
                                .foregroundStyle(theme.errorRed)
                                .fixedSize(horizontal: false, vertical: true)
                        } else if let skipReason {
                            Text(skipReason)
                                .styledFont(.caption)
                                .foregroundStyle(theme.tertiaryLabelColor)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, style.gridSize / 2)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(task.status == .running ? .updatesFrequently : [])
            }

            var statusBGColor: Color {
                switch task.status {
                case .completed:
                    theme.green
                case .failed:
                    theme.errorRed
                case .running:
                        .clear
                case .skipped:
                        .clear
                case .pending:
                        .clear
                case .unknown:
                        .clear
                }
            }

            @ViewBuilder
            private var statusIcon: some View {
                ZStack {
                    Circle().fill(statusBGColor)

                    switch task.status {
                    case .pending, .skipped, .unknown:
                        Circle().stroke(theme.tertiaryLabelColor)
                    case .running:
                        ProgressView()
                            .controlSize(.small)
                            .tint(theme.tertiaryLabelColor)
                    case .completed:
                        Image(systemName: "checkmark")
                            .font(.bold(9))
                            .foregroundStyle(.white)
                    case .failed:
                        Image(systemName: "xmark")
                            .font(.bold(9))
                            .foregroundStyle(.white)
                    }
                }
                .squareFrame(size: 16)
            }

            private var skipReason: String? {
                guard task.status == .skipped, let reason = task.skipReason else {
                    return nil
                }
                switch reason {
                case .noEnvironment:
                    return "No environment is connected to this session."
                case .noScript(_, let environmentName):
                    if let environmentName, !environmentName.isEmpty {
                        return "\(environmentName) does not have a setup script."
                    }
                    return "This environment does not have a setup script."
                case .unknown:
                    return nil
                }
            }

            private var label: String {
                switch task.id {
                case .cloudContainer:
                    cloudContainerLabel
                case .sessionConnector:
                    sessionConnectorLabel
                case .repository:
                    repositoryLabel
                case .setupScript:
                    setupScriptLabel
                case .networkPolicy:
                    networkPolicyLabel
                case .unknown(let value):
                    value.replacingOccurrences(of: "_", with: " ").capitalized
                }
            }

            private var cloudContainerLabel: String {
                switch task.status {
                case .pending, .completed, .unknown: "Set up cloud computer"
                case .running: "Setting up cloud computer"
                case .failed: "Cloud computer setup failed"
                case .skipped: "Skipped cloud computer setup"
                }
            }

            private var sessionConnectorLabel: String {
                switch task.status {
                case .pending, .unknown: "Secure session credentials"
                case .running: "Securing session credentials"
                case .completed: "Secured session credentials"
                case .failed: "Session credential setup failed"
                case .skipped: "Skipped session credential setup"
                }
            }

            private var repositoryLabel: String {
                switch task.status {
                case .pending, .unknown: "Clone repository"
                case .running: "Cloning repository"
                case .completed: "Cloned repository"
                case .failed: "Repository clone failed"
                case .skipped: "Skipped repository clone"
                }
            }

            private var setupScriptLabel: String {
                switch task.status {
                case .pending, .unknown: "Run setup script"
                case .running: "Running setup script"
                case .completed: "Completed setup script"
                case .failed: "Setup script failed"
                case .skipped: "Skipped setup script"
                }
            }

            private var networkPolicyLabel: String {
                switch task.status {
                case .pending, .unknown: "Apply network policy"
                case .running: "Applying network policy"
                case .completed: "Applied network policy"
                case .failed: "Network policy failed"
                case .skipped: "Skipped network policy"
                }
            }
        }
    }
}
