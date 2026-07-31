import Observation

@Observable final class SessionTranscriptRowViewModel {
    var workExpanded: Bool = false
    var userMessageExpanded: Bool = false
}

final class SessionTranscriptRowViewModelCache {
    private var viewModelsByItemID: [String: SessionTranscriptRowViewModel] = [:]

    func viewModel(for itemID: String) -> SessionTranscriptRowViewModel {
        if let viewModel = viewModelsByItemID[itemID] {
            return viewModel
        }

        let viewModel = SessionTranscriptRowViewModel()
        viewModelsByItemID[itemID] = viewModel
        return viewModel
    }

    func prune(keepingItemIDs itemIDs: [String]) {
        let itemIDs = Set(itemIDs)
        viewModelsByItemID = viewModelsByItemID.filter {
            itemIDs.contains($0.key)
        }
    }
}
