@testable import API
import CoreAPI
import Testing

@Suite("Cursor page")
struct CursorPageTests {
    @Test func exposesWhetherAnotherPageExists() {
        let intermediatePage = CursorPage(values: [1, 2], nextCursor: "next")
        let finalPage = CursorPage(values: [3], nextCursor: nil)

        #expect(intermediatePage.hasNextPage)
        #expect(!finalPage.hasNextPage)
    }

    @Test func appendsValuesAndAdvancesTheCursor() {
        let firstPage = CursorPage(values: [1, 2], nextCursor: "second")
        let secondPage = CursorPage(values: [3, 4], nextCursor: "third")

        let combinedPage = firstPage.appending(secondPage)

        #expect(combinedPage.values == [1, 2, 3, 4])
        #expect(combinedPage.nextCursor == "third")
    }

    @Test func mapsValuesWithoutChangingTheCursor() {
        let page = CursorPage(values: [1, 2], nextCursor: "next")

        let mappedPage = page.map { String($0) }

        #expect(mappedPage.values == ["1", "2"])
        #expect(mappedPage.nextCursor == "next")
    }

    @Test func sessionMappingPreservesRepositoryAndSessionCursors() {
        let response = ListSessionsResponse(
            groups: [
                SessionRepoGroup(
                    repoId: 42,
                    repoFullName: "owner/repo",
                    sessions: [
                        CoreAPI.SessionSummary(
                            id: "session-1",
                            repoId: 42,
                            repoFullName: "owner/repo",
                            archived: false,
                            workingState: .idle,
                            createdAt: "2026-07-27T00:00:00Z",
                            updatedAt: "2026-07-27T00:00:00Z",
                            hasUnread: false
                        )
                    ],
                    nextSessionCursor: "sessions-next"
                )
            ],
            nextRepoCursor: "repos-next"
        )

        let page = response.summaryPage

        #expect(page.nextCursor == "repos-next")
        #expect(page.values[0].sessions.nextCursor == "sessions-next")
        #expect(page.values[0].sessions.values.map(\.id) == ["session-1"])
    }
}
