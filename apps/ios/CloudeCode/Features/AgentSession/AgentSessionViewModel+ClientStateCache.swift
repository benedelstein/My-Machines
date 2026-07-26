import Domain
import Entities

extension AgentSessionViewModel {
    func loadCachedClientState() async {
        guard let session else {
            return
        }
        let cachedModels = try? await sessionClientStateStore.get(
            [session.id],
            scopes: [.memory, .disk]
        )
        guard !Task.isCancelled, let snapshot = cachedModels?.first?.snapshot else {
            return
        }

        let previousProvider = transcriptProvider
        updateSetupRunDisclosure(
            from: clientState.sessionSetupRun,
            to: snapshot.sessionSetupRun
        )
        clientState.repoFullName = snapshot.repoFullName
        clientState.status = snapshot.status
        clientState.sessionSetupRun = snapshot.sessionSetupRun
        clientState.agentSettings = snapshot.agentSettings
        clientState.pullRequest = snapshot.pullRequest
        clientState.pushedBranch = snapshot.pushedBranch
        clientState.baseBranch = snapshot.baseBranch
        clientState.agentMode = snapshot.agentMode
        clientStateIsResponding = snapshot.isResponding
        hasHydratedClientState = true

        if previousProvider != transcriptProvider, !messagesByID.isEmpty {
            rebuildTranscriptDisplayData()
        }
        reconcilePullRequestState()
    }

    func persistClientState() {
        guard let session, hasHydratedClientState, !hasDeletedSession else {
            return
        }

        let snapshot = SessionClientStateSnapshot(
            id: session.id,
            repoFullName: clientState.repoFullName,
            status: clientState.status,
            sessionSetupRun: clientState.sessionSetupRun,
            agentSettings: clientState.agentSettings,
            pullRequest: clientState.pullRequest,
            pushedBranch: clientState.pushedBranch,
            baseBranch: clientState.baseBranch,
            agentMode: clientState.agentMode,
            isResponding: isResponding
        )
        sessionClientStateStore.putSnapshotsToDisk([snapshot])
    }
}
