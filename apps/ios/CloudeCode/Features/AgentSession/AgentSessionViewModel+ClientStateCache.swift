import Domain

extension AgentSessionViewModel {
    var repoFullNameForDisplay: String? {
        hasHydratedClientState ? clientState.repoFullName : session?.repoFullName
    }

    var sessionStatusForDisplay: SessionClientState.Status {
        guard !hasHydratedClientState, let status = session?.status else {
            return clientState.status
        }
        return SessionClientState.Status(rawValue: status.rawValue)
    }

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
        lastCachedClientStateSnapshot = snapshot

        if previousProvider != transcriptProvider, !messagesByID.isEmpty {
            rebuildTranscriptDisplayData()
        }
        reconcilePullRequestState()
    }

    func persistClientStateIfNeeded(force: Bool = false) {
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
        guard force || snapshot != lastCachedClientStateSnapshot else {
            return
        }

        lastCachedClientStateSnapshot = snapshot
        sessionClientStateStore.putSnapshotsToDisk([snapshot])
    }
}
