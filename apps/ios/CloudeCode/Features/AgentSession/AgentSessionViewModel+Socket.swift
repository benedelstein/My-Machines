import API
import Foundation

extension AgentSessionViewModel {
    func bind() async {
        isBound = true
        hapticFeedback.prepare()
        updatePullRequestPolling()
        guard subscriptionTask == nil else {
            return
        }

        guard let socket else {
            // Draft mode: mark the transcript loaded immediately and fetch the
            // draft's data in the background so the user can start composing
            // right away instead of seeing a loading state.
            hasLoadedMessages = true
            async let catalogLoad: Void = modelCatalogStore.load()
            async let draftLoad: Void? = draft?.load()
            _ = await (catalogLoad, draftLoad)
            resolveDraftModelSelection()
            return
        }

        async let modelLoad: Void = modelCatalogStore.load()
        let subscriptionTask = startSocketPipeline(socket: socket)
        async let subscribeStream = subscriptionTask.value
        _ = await (modelLoad, subscribeStream)
    }

    func startSocketPipeline(socket: SessionSocket) -> Task<Void, Never> {
        let task = Task { [weak self, socket] in
            // No-op for a freshly created session: the optimistic message is
            // already in the transcript and hasLoadedMessages is set.
            await self?.loadCachedMessages()
            guard !Task.isCancelled else {
                return
            }
            await socket.connect()
            for await event in socket.events {
                guard !Task.isCancelled else {
                    return
                }
                await self?.handle(event)
            }
        }
        subscriptionTask = task
        return task
    }

    func unbind() {
        isBound = false
        hapticFeedback.stop()
        stopPullRequestPolling()
        subscriptionTask?.cancel()
        subscriptionTask = nil
        connectionState = .disconnected
        resetPendingResponse()

        Task { [socket] in
            await socket?.disconnect()
        }
    }
}
