import Domain
import Testing
@testable import CloudeCode

extension AgentSessionTranscriptStateTests {
    @Test func runningSetupRunStartsExpandedAndPreservesManualCollapse() {
        let viewModel = makeViewModel()
        let run = setupRun(status: .running, taskStatus: .running)

        viewModel.applyLiveState(liveState(provider: .claudeCode, setupRun: run))
        #expect(viewModel.isSetupRunExpanded)

        viewModel.toggleSetupRunExpansion()
        #expect(!viewModel.isSetupRunExpanded)

        viewModel.applyLiveState(liveState(
            provider: .claudeCode,
            setupRun: setupRun(status: .running, taskStatus: .completed)
        ))
        #expect(!viewModel.isSetupRunExpanded)
    }

    @Test func cleanSetupCompletionCollapsesTheRun() {
        let viewModel = makeViewModel()
        viewModel.applyLiveState(liveState(
            provider: .claudeCode,
            setupRun: setupRun(status: .running, taskStatus: .running)
        ))

        viewModel.applyLiveState(liveState(
            provider: .claudeCode,
            setupRun: setupRun(status: .completed, taskStatus: .completed)
        ))

        #expect(!viewModel.isSetupRunExpanded)
    }

    @Test func completedSetupWithNonBlockingFailureCollapsesTheRun() {
        let viewModel = makeViewModel()

        viewModel.applyLiveState(liveState(
            provider: .claudeCode,
            setupRun: setupRun(status: .completed, taskStatus: .failed)
        ))

        #expect(!viewModel.isSetupRunExpanded)
    }

    private func setupRun(
        status: SessionClientState.SessionSetupRun.Status,
        taskStatus: SessionClientState.SessionSetupTask.Status
    ) -> SessionClientState.SessionSetupRun {
        SessionClientState.SessionSetupRun(
            id: "setup-1",
            status: status,
            startedAt: "2026-01-01T00:00:00Z",
            completedAt: status == .running ? nil : "2026-01-01T00:01:00Z",
            tasks: [
                SessionClientState.SessionSetupTask(
                    id: .setupScript,
                    status: taskStatus,
                    startedAt: "2026-01-01T00:00:00Z",
                    completedAt: taskStatus == .running ? nil : "2026-01-01T00:01:00Z",
                    error: taskStatus == .failed ? "Script failed" : nil,
                    isBlocking: false,
                    canRetry: false,
                    output: nil
                )
            ]
        )
    }
}
