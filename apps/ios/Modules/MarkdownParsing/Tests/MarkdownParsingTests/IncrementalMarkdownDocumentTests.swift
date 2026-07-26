import Foundation
@testable import MarkdownParsing
import Testing

@Suite("Incremental Markdown document")
struct IncrementalMarkdownDocumentTests {
    @Test func headingAndListProduceSemanticBlocks() {
        var document = IncrementalMarkdownDocument()
        let source = "# Heading\n\n3. Three\n4. Four"

        let snapshot = document.update(source: source, isStreaming: false)

        #expect(snapshot.parts.map(\.source).joined() == source)
        #expect(snapshot.parts.count == 2)
        guard case .heading(level: 1, content: let heading) = snapshot.parts[0].block.content else {
            Issue.record("Expected heading")
            return
        }
        #expect(String(heading.characters) == "Heading")
        guard case .orderedList(startIndex: 3, items: let items) = snapshot.parts[1].block.content else {
            Issue.record("Expected ordered list")
            return
        }
        #expect(items.count == 2)
    }

    @Test func parsesHeadingsBreaksQuotesCodeAndTasks() {
        let source = """
        Heading
        =======

        ---

        > Quote
        >
        > - [x] done
        > - [ ] next

            indented()

        ```swift
        fenced()
        ```
        """
        let snapshot = completed(source)

        #expect(snapshot.parts.map(\.source).joined() == source)
        #expect(snapshot.parts.count == 5)
        guard case .heading(level: 1, _) = snapshot.parts[0].block.content else {
            Issue.record("Expected Setext heading")
            return
        }
        guard case .thematicBreak = snapshot.parts[1].block.content else {
            Issue.record("Expected thematic break")
            return
        }
        guard case .blockQuote(let blocks) = snapshot.parts[2].block.content,
              case .unorderedList(let items) = blocks.last?.content else {
            Issue.record("Expected quoted task list")
            return
        }
        #expect(items.map(\.checkbox) == [.checked, .unchecked])
        guard case .codeBlock(let indented) = snapshot.parts[3].block.content else {
            Issue.record("Expected indented code")
            return
        }
        #expect(indented.language == nil)
        guard case .codeBlock(let fenced) = snapshot.parts[4].block.content else {
            Issue.record("Expected fenced code")
            return
        }
        #expect(fenced.language == "swift")
    }

    @Test func parsesInlineIntentsLinksBareURLsAndImageAltText() {
        let source = "**bold** *italic* ~~strike~~ `code` [link](https://example.com/a) "
            + "https://example.com/b. ![alt](https://example.com/image.png)"
        let snapshot = completed(source)
        guard case .prose(let paragraphs) = snapshot.parts.first?.block.content,
              let content = paragraphs.first?.content else {
            Issue.record("Expected prose")
            return
        }

        #expect(String(content.characters) == "bold italic strike code link https://example.com/b. alt")
        #expect(content.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(content.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        #expect(content.runs.contains { $0.inlinePresentationIntent?.contains(.strikethrough) == true })
        #expect(content.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        #expect(content.runs.filter { $0.link != nil }.count == 3)
    }

    @Test func smartPunctuationIsDisabled() {
        let source = #"--flag --- "straight""#
        let snapshot = completed(source)
        guard case .prose(let paragraphs) = snapshot.parts.first?.block.content else {
            Issue.record("Expected prose")
            return
        }
        #expect(String(paragraphs[0].content.characters) == source)
    }

    @Test func tablesParseIntoRowsAndHTMLRemainsAnAtomicLiteral() {
        let source = "| A | B |\n| - | - |\n| 1 | 2 |\n\n<section>HTML</section>"
        let snapshot = completed(source)

        #expect(snapshot.parts.map(\.source).joined() == source)
        #expect(snapshot.parts.count == 2)
        guard case .table(let table) = snapshot.parts[0].block.content,
              case .literal = snapshot.parts[1].block.content else {
            Issue.record("Expected a table followed by an HTML literal")
            return
        }
        #expect(table.header?.cells.map { String($0.content.characters) } == ["A", "B"])
        #expect(table.rows.map { row in row.cells.map { String($0.content.characters) } } == [["1", "2"]])
        #expect(table.columnCount == 2)
    }

    @Test func tableColumnsCarryAlignmentAndCellsCarryInlineStyling() {
        let source = """
        | Service | `--http-port` | Reachable |
        | :--- | :---: | ---: |
        | **api** | 8080 | the public URL |
        | worker | — | nothing external |
        """
        let snapshot = completed(source)

        guard case .table(let table) = snapshot.parts.first?.block.content else {
            Issue.record("Expected a table")
            return
        }
        #expect(table.columnAlignments == [.leading, .center, .trailing])
        #expect(table.alignment(forColumn: 1) == .center)
        #expect(table.alignment(forColumn: 9) == .leading)
        #expect(table.rows.count == 2)

        guard let header = table.header else {
            Issue.record("Expected a table header")
            return
        }
        #expect(header.cells.map { String($0.content.characters) } == ["Service", "--http-port", "Reachable"])
        #expect(header.cells[1].content.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        let api = table.rows[0].cells[0].content
        #expect(api.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    }

    @Test func undeclaredAlignmentsAndSpanningCellsStayColumnAligned() {
        let source = """
        | one | two | three |
        | --- | --- | ----- |
        | big      || small |
        """
        let snapshot = completed(source)

        guard case .table(let table) = snapshot.parts.first?.block.content else {
            Issue.record("Expected a table")
            return
        }
        #expect(table.columnAlignments == [nil, nil, nil])
        // The covered cell is dropped, and its column is accounted for by the spanning cell.
        #expect(table.rows[0].cells.map(\.columnSpan) == [2, 1])
        #expect(table.rows[0].cells.map { String($0.content.characters) } == ["big", "small"])
        #expect(table.columnCount == 3)
    }

    @Test func streamingTableGrowsRowsAndStaysOnePart() {
        var document = IncrementalMarkdownDocument()
        _ = document.update(source: "| A | B |\n| - | - |", isStreaming: true)
        let partial = document.update(source: "| A | B |\n| - | - |\n| 1 | 2 |", isStreaming: true)
        let complete = document.update(source: "| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |", isStreaming: false)

        guard case .table(let partialTable) = partial.parts.first?.block.content,
              case .table(let completeTable) = complete.parts.first?.block.content else {
            Issue.record("Expected the streaming table to stay a table")
            return
        }
        #expect(partial.parts.count == 1)
        #expect(complete.parts.count == 1)
        #expect(partialTable.rows.count == 1)
        #expect(completeTable.rows.count == 2)
        #expect(complete.parts[0].stability == .finalized)
    }

    @Test func streamingHoldsAdjacentPredecessorUntilBlankLineMakesItStable() {
        var document = IncrementalMarkdownDocument()
        let adjacent = document.update(source: "para\n***", isStreaming: true)
        #expect(adjacent.parts.allSatisfy { $0.stability == .active })

        let reinterpreted = document.update(source: "para\n***x", isStreaming: true)
        #expect(reinterpreted.parts.count == 1)
        #expect(reinterpreted.parts[0].stability == .active)

        document.reset()
        let separated = document.update(source: "para\n\n***", isStreaming: true)
        #expect(separated.parts[0].stability == .finalized)
        #expect(separated.parts[1].stability == .active)
    }

    @Test func sixStreamingParagraphsFinalizeTheFirstFive() {
        var document = IncrementalMarkdownDocument()
        let source = (1...6).map { "Paragraph \($0)." }.joined(separator: "\n\n")
        let snapshot = document.update(source: source, isStreaming: true)

        #expect(snapshot.parts.count == 2)
        #expect(snapshot.parts[0].stability == .finalized)
        #expect(snapshot.parts[1].stability == .active)
        guard case .prose(let first) = snapshot.parts[0].block.content,
              case .prose(let second) = snapshot.parts[1].block.content else {
            Issue.record("Expected prose batches")
            return
        }
        #expect(first.count == 5)
        #expect(second.count == 1)
    }

    @Test func longProseUsesUnicodeSafeContinuationParts() {
        var configuration = IncrementalMarkdownDocument.Configuration()
        configuration.maximumProseUTF16Length = 24
        configuration.softBoundaryLookbackUTF16Length = 12
        configuration.minimumSoftBoundaryUTF16Length = 8
        var document = IncrementalMarkdownDocument(configuration: configuration)
        let source = "alpha 😀 beta ``` inline ticks stay prose and # heading stays prose"
        let snapshot = document.update(source: source, isStreaming: true)

        #expect(snapshot.parts.count > 1)
        #expect(snapshot.parts.map(\.source).joined() == source)
        #expect(snapshot.parts.dropFirst().contains { $0.leadingBoundary == .proseContinuation })
        #expect(snapshot.parts.allSatisfy {
            if case .prose = $0.block.content { return true }
            return false
        })
    }

    @Test func oversizedOpenInlineCodeMakesBoundedProgress() {
        var configuration = IncrementalMarkdownDocument.Configuration()
        configuration.maximumProseUTF16Length = 24
        configuration.softBoundaryLookbackUTF16Length = 12
        configuration.minimumSoftBoundaryUTF16Length = 8
        var document = IncrementalMarkdownDocument(configuration: configuration)
        let openSource = "prefix `" + String(repeating: "code word ", count: 8)

        let open = document.update(source: openSource, isStreaming: true)

        #expect(open.parts.count > 1)
        #expect(open.parts.dropLast().allSatisfy { $0.stability == .finalized })
        #expect(open.parts.last?.stability == .active)
        #expect(open.parts.allSatisfy { $0.source.utf16.count <= 24 })
        #expect(open.parts.map(\.source).joined() == openSource)

        let closedSource = openSource + "` safe trailing words for another part"
        let closed = document.update(source: closedSource, isStreaming: true)
        #expect(closed.parts.count > 1)
        #expect(closed.parts.map(\.source).joined() == closedSource)
    }

    @Test func appendedReferenceSwitchesToWholeDocumentAndUpdatesEarlierLink() {
        var document = IncrementalMarkdownDocument()
        let initial = document.update(source: "See [docs][docs].", isStreaming: true)
        #expect(initial.mode == .incrementalTail)

        let source = "See [docs][docs].\n\n[docs]: https://example.com"
        let updated = document.update(source: source, isStreaming: true)
        #expect(updated.mode == .wholeDocument)
        #expect(updated.parts.map(\.source).joined() == source)
        guard case .prose(let paragraphs) = updated.parts.first?.block.content else {
            Issue.record("Expected linked prose")
            return
        }
        #expect(paragraphs[0].content.runs.contains { $0.link?.absoluteString == "https://example.com" })

        let completed = document.update(source: source, isStreaming: false)
        #expect(completed.mode == .wholeDocument)
        #expect(completed.parts.allSatisfy { $0.stability == .finalized })
    }

    @Test func definitionOnlySourceUsesSourceOnlyPart() {
        let source = "[docs]: https://example.com"
        let snapshot = completed(source)
        #expect(snapshot.mode == .wholeDocument)
        #expect(snapshot.parts.map(\.source).joined() == source)
        guard case .sourceOnly = snapshot.parts[0].block.content else {
            Issue.record("Expected source-only part")
            return
        }
    }

    @Test func definitionLikeTextInsideFinalizedCodeDoesNotChangeMode() {
        var document = IncrementalMarkdownDocument()
        let code = "```text\n[docs]: https://example.com\n```\n\n"
        _ = document.update(source: code + "Tail", isStreaming: true)
        let updated = document.update(source: code + "Tail grows", isStreaming: true)

        #expect(updated.mode == .incrementalTail)
        #expect(updated.parts.map(\.source).joined() == code + "Tail grows")
    }

    @Test func definitionLikeTextInsideFinalizedIndentedCodeDoesNotChangeMode() {
        var document = IncrementalMarkdownDocument()
        let code = "    [docs]: https://example.com\n\n"
        _ = document.update(source: code + "Tail", isStreaming: true)
        let updated = document.update(source: code + "Tail grows", isStreaming: true)

        #expect(updated.mode == .incrementalTail)
        #expect(updated.parts.map(\.source).joined() == code + "Tail grows")
    }

    @Test func everyStreamingPrefixPreservesRawSource() {
        let source = "Intro 😀\r\n\r\n# Heading\n\n- one\n  - nested\n\n```swift\nlet x = 1\n```\n\nEnd"
        var document = IncrementalMarkdownDocument()
        var prefix = ""
        for character in source {
            prefix.append(character)
            let snapshot = document.update(source: prefix, isStreaming: true)
            #expect(snapshot.parts.map(\.source).joined() == prefix)
        }
        let completed = document.update(source: source, isStreaming: false)
        #expect(completed.parts.map(\.source).joined() == source)
    }

    @Test func replacementAndShrinkResetSourceIdentities() {
        var document = IncrementalMarkdownDocument()
        _ = document.update(source: "First\n\nSecond", isStreaming: true)
        let replaced = document.update(source: "Other\n\nSecond", isStreaming: true)
        #expect(replaced.parts.map(\.source).joined() == "Other\n\nSecond")
        #expect(replaced.parts.first?.id.utf16SourceOffset == 0)

        let shrunk = document.update(source: "Short", isStreaming: true)
        #expect(shrunk.parts.map(\.source).joined() == "Short")
        #expect(shrunk.parts.first?.id.utf16SourceOffset == 0)
    }

    @Test func growingLargeListPreservesExistingItemIdentities() {
        var document = IncrementalMarkdownDocument()
        let firstSource = (1...25).map { "- item \($0)" }.joined(separator: "\n")
        let first = document.update(source: firstSource, isStreaming: true)
        guard case .unorderedList(let firstItems) = first.parts[0].block.content else {
            Issue.record("Expected list")
            return
        }

        let secondSource = firstSource + "\n- item 26"
        let second = document.update(source: secondSource, isStreaming: true)
        guard case .unorderedList(let secondItems) = second.parts[0].block.content else {
            Issue.record("Expected growing list")
            return
        }

        #expect(first.parts.count == 1)
        #expect(second.parts.count == 1)
        #expect(Array(secondItems.prefix(25)).map(\.id) == firstItems.map(\.id))
        #expect(secondItems[25].id != firstItems[24].id)
    }

    @Test func parsesAllATXHeadingLevels() {
        let source = (1...6).map { level in
            String(repeating: "#", count: level) + " Heading \(level)"
        }.joined(separator: "\n\n")
        let snapshot = completed(source)

        #expect(snapshot.parts.map(\.source).joined() == source)
        #expect(snapshot.parts.count == 6)
        for (index, part) in snapshot.parts.enumerated() {
            guard case .heading(let level, let content) = part.block.content else {
                Issue.record("Expected heading at index \(index)")
                continue
            }
            #expect(level == index + 1)
            #expect(String(content.characters) == "Heading \(index + 1)")
        }
    }

    @Test func parsesNestedMixedTightAndLooseLists() {
        let source = """
        - tight one
          1. nested ordered
          2. nested ordered two
        - tight two

        - loose one

          continuation paragraph
        - loose two
          - nested unordered
        """
        let snapshot = completed(source)

        #expect(snapshot.parts.map(\.source).joined() == source)
        #expect(snapshot.parts.count == 1)
        guard case .unorderedList(let items) = snapshot.parts[0].block.content else {
            Issue.record("Expected unordered list")
            return
        }
        #expect(items.count == 4)
        #expect(items[0].blocks.contains { block in
            if case .orderedList = block.content { return true }
            return false
        })
        #expect(items[2].blocks.count == 2)
        #expect(items[3].blocks.contains { block in
            if case .unorderedList = block.content { return true }
            return false
        })
    }

    @Test func parsesOpenAndClosedFences() {
        let open = completed("```swift\nlet value = 1")
        let closed = completed("```swift\nlet value = 1\n```")

        for snapshot in [open, closed] {
            guard case .codeBlock(let code) = snapshot.parts.first?.block.content else {
                Issue.record("Expected code block")
                continue
            }
            #expect(code.language == "swift")
            #expect(code.code.trimmingCharacters(in: .newlines) == "let value = 1")
        }
    }

    @Test func parsesBoldItalicAndNestedQuotesContainingCode() {
        let source = "> Outer\n>\n> > ***nested***\n> >\n> >     code()"
        let snapshot = completed(source)

        guard case .blockQuote(let outerBlocks) = snapshot.parts.first?.block.content,
              case .blockQuote(let innerBlocks) = outerBlocks.last?.content,
              case .prose(let paragraphs) = innerBlocks.first?.content else {
            Issue.record("Expected nested quote prose")
            return
        }
        let content = paragraphs[0].content
        #expect(content.runs.contains { run in
            run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
                && run.inlinePresentationIntent?.contains(.emphasized) == true
        })
        #expect(innerBlocks.contains { block in
            if case .codeBlock = block.content { return true }
            return false
        })
    }

    @Test func onlyOneAdjacentPredecessorIsHeldBack() {
        var document = IncrementalMarkdownDocument()
        let source = "# Stable\n\nParagraph\n***"
        let snapshot = document.update(source: source, isStreaming: true)

        #expect(snapshot.parts.count == 3)
        #expect(snapshot.parts[0].stability == .finalized)
        #expect(snapshot.parts[1].stability == .active)
        #expect(snapshot.parts[2].stability == .active)
    }

    @Test func streamingSetextAndTableCandidatesCanBeReinterpreted() {
        var setextDocument = IncrementalMarkdownDocument()
        let setext = setextDocument.update(source: "Title\n---", isStreaming: true)
        let setextChanged = setextDocument.update(source: "Title\n---x", isStreaming: true)

        guard case .heading(level: 2, _) = setext.parts.first?.block.content,
              case .prose = setextChanged.parts.first?.block.content else {
            Issue.record("Expected Setext heading to return to prose")
            return
        }
        #expect(setext.parts.allSatisfy { $0.stability == .active })
        #expect(setextChanged.parts.allSatisfy { $0.stability == .active })

        var tableDocument = IncrementalMarkdownDocument()
        let table = tableDocument.update(source: "| A |\n| - |", isStreaming: true)
        let tableChanged = tableDocument.update(source: "| A |\n| - |x", isStreaming: true)
        guard case .table = table.parts.first?.block.content,
              case .prose = tableChanged.parts.first?.block.content else {
            Issue.record("Expected table candidate to return to prose")
            return
        }
    }

    @Test func finalizedPartsRemainIdenticalAsTailGrows() {
        var document = IncrementalMarkdownDocument()
        let firstSource = (1...6).map { "Paragraph \($0)." }.joined(separator: "\n\n")
        let first = document.update(source: firstSource, isStreaming: true)
        let finalized = first.parts[0]

        let second = document.update(source: firstSource + " More text.", isStreaming: true)

        #expect(second.parts[0] == finalized)
        #expect(second.parts[0].id == finalized.id)
        #expect(second.parts[0].stability == .finalized)
    }

    @Test func fiveParagraphsBatchAndSemanticBlocksFlushUnderfilledRuns() {
        var document = IncrementalMarkdownDocument()
        let fiveSource = (1...5).map { "Paragraph \($0)." }.joined(separator: "\n\n")
        let five = document.update(source: fiveSource, isStreaming: true)
        guard case .prose(let fiveParagraphs) = five.parts.first?.block.content else {
            Issue.record("Expected prose batch")
            return
        }
        #expect(five.parts.count == 1)
        #expect(fiveParagraphs.count == 5)

        document.reset()
        let mixed = document.update(
            source: "First.\n\nSecond.\n\n# Heading\n\nTail.",
            isStreaming: true
        )
        guard case .prose(let leadingParagraphs) = mixed.parts[0].block.content,
              case .heading = mixed.parts[1].block.content else {
            Issue.record("Expected prose followed by heading")
            return
        }
        #expect(leadingParagraphs.count == 2)
        #expect(mixed.parts[0].stability == .finalized)
    }

    @Test func completionFlushesUnderfilledProse() {
        let snapshot = completed("First.\n\nSecond.")

        guard case .prose(let paragraphs) = snapshot.parts.first?.block.content else {
            Issue.record("Expected prose")
            return
        }
        #expect(snapshot.parts.count == 1)
        #expect(paragraphs.count == 2)
        #expect(snapshot.parts[0].stability == .finalized)
    }

    @Test func semanticBlocksRemainAtomicBeyondProseCap() {
        var configuration = hardCapConfiguration
        configuration.maximumProseUTF16Length = 12
        let fixtures = [
            (1...20).map { "- list item \($0)" }.joined(separator: "\n"),
            "> " + String(repeating: "quoted words ", count: 20),
            "```text\n" + String(repeating: "code words ", count: 20) + "\n```",
            "| Column |\n| --- |\n| " + String(repeating: "value ", count: 20) + "|"
        ]

        for source in fixtures {
            var document = IncrementalMarkdownDocument(configuration: configuration)
            let snapshot = document.update(source: source, isStreaming: false)
            #expect(snapshot.parts.count == 1)
            #expect(snapshot.parts[0].source == source)
        }
    }

    @Test func hardCapPreservesClosedInlineConstructs() {
        let fixtures = [
            "prefix **" + String(repeating: "bold words ", count: 6) + "bold** trailing words trailing words",
            "prefix [" + String(repeating: "linked words ", count: 6)
                + "](https://example.com) trailing words trailing words",
            "prefix ``" + String(repeating: "code ` words ", count: 6) + "`` trailing words trailing words",
            #"prefix escaped \* marker and trailing words trailing words trailing words"#
        ]

        for source in fixtures {
            var document = IncrementalMarkdownDocument(configuration: hardCapConfiguration)
            let snapshot = document.update(source: source, isStreaming: false)
            #expect(snapshot.parts.count > 1)
            #expect(snapshot.parts.map(\.source).joined() == source)
        }
    }

    @Test func hardCapHandlesIntrawordUnderscoresAndUnbrokenText() {
        let fixtures = [
            "prefix snake_case " + String(repeating: "trailing words ", count: 10),
            String(repeating: "a", count: 120),
            String(repeating: "😀", count: 50)
        ]

        for source in fixtures {
            var document = IncrementalMarkdownDocument(configuration: hardCapConfiguration)
            let snapshot = document.update(source: source, isStreaming: false)
            #expect(snapshot.parts.count > 1)
            #expect(snapshot.parts.map(\.source).joined() == source)
            #expect(snapshot.parts.allSatisfy { part in
                part.source.utf16.count <= 40
            })
        }
    }

    @Test func openEmphasisStillMakesBoundedProgress() {
        var document = IncrementalMarkdownDocument(configuration: hardCapConfiguration)
        let openSource = "prefix **" + String(repeating: "bold words ", count: 8)
        let open = document.update(source: openSource, isStreaming: true)

        #expect(open.parts.count > 1)
        #expect(open.parts.dropLast().allSatisfy { $0.stability == .finalized })
        #expect(open.parts.last?.stability == .active)
        #expect(open.parts.allSatisfy { $0.source.utf16.count <= 24 })

        let closedSource = openSource + "final** safe trailing words safe trailing words"
        let closed = document.update(source: closedSource, isStreaming: true)
        #expect(closed.parts.count > 1)
        #expect(closed.parts.map(\.source).joined() == closedSource)
    }

    @Test func midLineMarkersStayProseAndLaterBlockOpenersStillParse() {
        var document = IncrementalMarkdownDocument(configuration: hardCapConfiguration)
        let source = String(repeating: "prefix words ", count: 5)
            + "# not heading - not list > not quote\n\n# Real heading"
        let snapshot = document.update(source: source, isStreaming: false)

        #expect(snapshot.parts.dropLast().allSatisfy { part in
            if case .prose = part.block.content { return true }
            return false
        })
        #expect(snapshot.parts.dropFirst().contains { $0.leadingBoundary == .proseContinuation })
        guard case .heading(level: 1, _) = snapshot.parts.last?.block.content else {
            Issue.record("Expected real heading on later physical line")
            return
        }
    }

    @Test func inlineTripleBackticksAfterMidLineSplitDoNotBecomeCodeFence() {
        var document = IncrementalMarkdownDocument(configuration: hardCapConfiguration)
        let initialSource = "alpha 😀 beta gamma delta epsilon zeta eta theta"
        let initial = document.update(source: initialSource, isStreaming: true)
        #expect(initial.parts.contains { $0.leadingBoundary == .proseContinuation })

        let inlineSource = initialSource + " ``` inline ticks # not heading - not list > not quote"
        let inline = document.update(source: inlineSource, isStreaming: true)
        #expect(inline.parts.map(\.source).joined() == inlineSource)
        #expect(inline.parts.allSatisfy { part in
            if case .prose = part.block.content { return true }
            return false
        })

        let headingSource = inlineSource + "\n\n# Real heading"
        let heading = document.update(source: headingSource, isStreaming: true)
        #expect(heading.parts.map(\.source).joined() == headingSource)
        guard case .heading(level: 1, _) = heading.parts.last?.block.content else {
            Issue.record("Expected block syntax on a later physical line")
            return
        }
    }

    @Test func definitionBeforeReferenceAndMultipleReferencesResolve() {
        let source = """
        [docs]: https://example.com/docs
        [api]: https://example.com/api

        Read [docs][docs] and [API][api].
        """
        let snapshot = completed(source)

        #expect(snapshot.mode == .wholeDocument)
        guard case .prose(let paragraphs) = snapshot.parts.last?.block.content else {
            Issue.record("Expected linked prose")
            return
        }
        let links = paragraphs[0].content.runs.compactMap { $0.link?.absoluteString }
        #expect(links == ["https://example.com/docs", "https://example.com/api"])
    }

    @Test func containerDefinitionsSelectWholeDocumentMode() {
        let fixtures = [
            "> [docs]: https://example.com",
            "- [docs]: https://example.com",
            "  1. [docs]: https://example.com"
        ]

        for source in fixtures {
            var document = IncrementalMarkdownDocument()
            let snapshot = document.update(source: source, isStreaming: true)
            #expect(snapshot.mode == .wholeDocument)
            #expect(snapshot.parts.map(\.source).joined() == source)
        }
    }

    @Test func definitionsInsideTildeFencesAreIgnored() {
        var document = IncrementalMarkdownDocument()
        let source = "~~~text\n[docs]: https://example.com\n~~~\n\nTail"
        let snapshot = document.update(source: source, isStreaming: true)

        #expect(snapshot.mode == .incrementalTail)
        #expect(snapshot.parts.map(\.source).joined() == source)
    }

    @Test func wholeDocumentModePersistsUntilReset() {
        var document = IncrementalMarkdownDocument()
        let source = "[docs]: https://example.com\n\nRead [docs]."
        let initial = document.update(source: source, isStreaming: true)
        let appended = document.update(source: source + " More.", isStreaming: true)

        #expect(initial.mode == .wholeDocument)
        #expect(appended.mode == .wholeDocument)

        document.reset()
        let reset = document.update(source: "Plain text", isStreaming: true)
        #expect(reset.mode == .incrementalTail)
    }

    @Test func unicodeSourceOffsetsUseUTF16AcrossCRLFAndCombiningMarks() {
        let prefix = "😀 e\u{301}\r\n\r\n"
        let source = prefix + "# Héading"
        let snapshot = completed(source)

        #expect(snapshot.parts.map(\.source).joined() == source)
        guard let heading = snapshot.parts.last else {
            Issue.record("Expected heading")
            return
        }
        #expect(heading.id.utf16SourceOffset == prefix.utf16.count)
        guard case .heading(_, let content) = heading.block.content else {
            Issue.record("Expected heading content")
            return
        }
        #expect(String(content.characters) == "Héading")
    }

    @Test func parserUsesAbsoluteOffsetsWhenParsingAfterZero() {
        let parsed = parseMarkdown(source: "# 😀 Heading", absoluteUTF16Offset: 37)

        #expect(parsed.blocks.count == 1)
        #expect(parsed.blocks[0].absoluteSourceRange == 37..<(37 + "# 😀 Heading".utf16.count))
        #expect(parsed.blocks[0].block.id.utf16SourceOffset == 37)
    }

    @Test func characterStreamingConvergesToOneShotOutput() {
        let source = "Intro 😀 e\u{301}\r\n\r\n# Heading\n\n- one\n- two\n\n> Quote\n\n```swift\ncode()\n```"
        var streamingDocument = IncrementalMarkdownDocument()
        var prefix = ""
        for character in source {
            prefix.append(character)
            _ = streamingDocument.update(source: prefix, isStreaming: true)
        }
        let streaming = streamingDocument.update(source: source, isStreaming: false)
        let oneShot = completed(source)

        #expect(streaming == oneShot)
    }

    @Test func identicalInputReturnsAnEqualCachedSnapshot() {
        let parser = RecordingMarkdownParser()
        var document = IncrementalMarkdownDocument(configuration: .init(), parser: parser)
        let first = document.update(source: "# Heading\n\nTail", isStreaming: true)
        let parseCount = parser.calls.count
        let second = document.update(source: "# Heading\n\nTail", isStreaming: true)

        #expect(second == first)
        #expect(parser.calls.count == parseCount)
    }

    @Test func finalizedPrefixIsExcludedFromLaterParseCalls() {
        let parser = RecordingMarkdownParser()
        var configuration = IncrementalMarkdownDocument.Configuration()
        configuration.maximumParagraphsPerPart = 1
        var document = IncrementalMarkdownDocument(configuration: configuration, parser: parser)
        let firstSource = "First paragraph.\n\nSecond paragraph."
        let first = document.update(source: firstSource, isStreaming: true)
        guard let finalized = first.parts.first, finalized.stability == .finalized else {
            Issue.record("Expected finalized prefix")
            return
        }

        let secondSource = firstSource + " More."
        _ = document.update(source: secondSource, isStreaming: true)
        let thirdSource = secondSource + " Again."
        _ = document.update(source: thirdSource, isStreaming: true)

        let calls = parser.calls
        #expect(calls.count == 3)
        #expect(calls[0].source == firstSource)
        #expect(calls[0].absoluteUTF16Offset == 0)
        #expect(calls[1].source == "Second paragraph. More.")
        #expect(calls[1].absoluteUTF16Offset == finalized.source.utf16.count)
        #expect(calls[2].source == "Second paragraph. More. Again.")
        #expect(calls[2].absoluteUTF16Offset == finalized.source.utf16.count)
    }
}

private func completed(_ source: String) -> MarkdownRenderSnapshot {
    var document = IncrementalMarkdownDocument()
    return document.update(source: source, isStreaming: false)
}

private var hardCapConfiguration: IncrementalMarkdownDocument.Configuration {
    var configuration = IncrementalMarkdownDocument.Configuration()
    configuration.maximumProseUTF16Length = 24
    configuration.softBoundaryLookbackUTF16Length = 12
    configuration.minimumSoftBoundaryUTF16Length = 8
    return configuration
}

private final class RecordingMarkdownParser: MarkdownParserProtocol, @unchecked Sendable {
    struct Call: Sendable {
        let source: String
        let absoluteUTF16Offset: Int
    }

    private let lock = NSLock()
    private var storedCalls: [Call] = []

    var calls: [Call] {
        lock.lock()
        defer { lock.unlock() }
        return storedCalls
    }

    func parse(source: String, absoluteUTF16Offset: Int) -> ParsedMarkdown {
        lock.lock()
        storedCalls.append(.init(source: source, absoluteUTF16Offset: absoluteUTF16Offset))
        lock.unlock()
        return parseMarkdown(source: source, absoluteUTF16Offset: absoluteUTF16Offset)
    }
}
