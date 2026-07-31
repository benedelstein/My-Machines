@testable import CloudeCode
import Domain
import Testing

@Suite("Agent session transcript builder")
struct AgentSessionTranscriptBuilderTests {
    private let builder: AgentSessionTranscriptBuilder = AgentSessionTranscriptBuilder()

    @Test func groupsAdjacentCompatibleActions() {
        let items = builder.build(
            message: message(parts: [
                tool("Read", callId: "read-1", input: ["file_path": .string("/a.swift")]),
                tool("Read", callId: "read-2", input: ["file_path": .string("/b.swift")])
            ]),
            providerId: .claudeCode
        )

        #expect(items.count == 1)
        if case .actionItem(.group(let group)) = items.first {
            #expect(group.kind == .read)
            #expect(group.actions.map(\.toolCallId) == ["read-1", "read-2"])
            #expect(group.key == "m1-actions-0-0-group-read-1-read")
        } else {
            Issue.record("Expected grouped read actions")
        }
    }

    @Test func doesNotGroupAcrossTextOrReasoning() {
        let items = builder.build(
            message: message(parts: [
                tool("Read", callId: "read-1", input: ["file_path": .string("/a.swift")]),
                .text(.init(text: "done")),
                tool("Read", callId: "read-2", input: ["file_path": .string("/b.swift")]),
                .reasoning(.init(text: "thinking")),
                tool("Read", callId: "read-3", input: ["file_path": .string("/c.swift")])
            ]),
            providerId: .claudeCode
        )

        #expect(items.count == 5)
        #expect(items.map(\.key) == [
            "m1-actions-0-0-single-read-1",
            "m1-text-1",
            "m1-actions-2-0-single-read-2",
            "m1-reasoning-3",
            "m1-actions-4-0-single-read-3"
        ])
    }

    @Test func keepsNonGroupableActionsStandalone() {
        let items = builder.build(
            message: message(parts: [
                tool("Edit", callId: "edit-1", input: editInput(path: "/a.swift", from: "a", to: "b")),
                tool("Edit", callId: "edit-2", input: editInput(path: "/b.swift", from: "c", to: "d")),
                tool("TodoWrite", callId: "todo-1", input: ["todos": .array([])]),
                tool("ExitPlanMode", callId: "plan-1", input: ["plan": .string("Plan")])
            ]),
            providerId: .claudeCode
        )

        let actionItems = items.compactMap { item -> AgentSessionRenderItem.ActionItem? in
            if case .actionItem(let actionItem) = item { return actionItem }
            return nil
        }

        #expect(actionItems.count == 4)
        #expect(actionItems.allSatisfy { $0.isSingle })
    }

    @Test func groupedBashTitleReflectsCompletedActiveAndPendingPhases() {
        let completedGroup = groupedActionItem(parts: [
            tool("Bash", callId: "bash-1", state: "output-available", input: ["command": .string("pwd")]),
            tool("Bash", callId: "bash-2", state: "output-available", input: ["command": .string("ls")])
        ])
        #expect(completedGroup?.title() == "Ran 2 commands")

        let activeGroup = groupedActionItem(parts: [
            tool("Bash", callId: "bash-1", state: "output-available", input: ["command": .string("pwd")]),
            tool("Bash", callId: "bash-2", state: "input-available", input: ["command": .string("ls")])
        ])
        #expect(activeGroup?.title() == "Running 2 commands")

        let pendingGroup = groupedActionItem(parts: [
            tool("Bash", callId: "bash-1", state: "input-streaming", input: ["command": .string("pwd")]),
            tool("Bash", callId: "bash-2", state: "input-streaming", input: ["command": .string("ls")])
        ])
        #expect(pendingGroup?.title() == "Run 2 commands")
    }

    @Test func activeFinalGroupOverridesStateForStreamingLabel() {
        let group = groupedActionItem(parts: [
            tool("Bash", callId: "bash-1", state: "input-streaming", input: ["command": .string("pwd")]),
            tool("Bash", callId: "bash-2", state: "input-streaming", input: ["command": .string("ls")])
        ])

        #expect(group?.title(isActive: true) == "Running 2 commands")
    }

    @Test func todoTitleReflectsCompletedActiveAndPendingPhases() {
        let completedTodo = singleActionItem(
            part: tool("TodoWrite", callId: "todo-1", state: "output-available", input: ["todos": .array([])])
        )
        #expect(completedTodo?.title() == "Updated todos")

        let activeTodo = singleActionItem(
            part: tool("TodoWrite", callId: "todo-1", state: "input-available", input: ["todos": .array([])])
        )
        #expect(activeTodo?.title() == "Updating todos")

        let pendingTodo = singleActionItem(
            part: tool("TodoWrite", callId: "todo-1", state: "input-streaming", input: ["todos": .array([])])
        )
        #expect(pendingTodo?.title() == "Update todos")
        #expect(pendingTodo?.title(isActive: true) == "Updating todos")
    }

    @Test func usesProviderForToolNormalization() {
        let items = builder.build(
            message: message(parts: [
                tool("exec", callId: "exec-1", input: [
                    "type": .string("commandExecution"),
                    "command": .string("pwd")
                ])
            ]),
            providerId: .openaiCodex
        )

        if case .actionItem(.single(let single)) = items.first {
            #expect(single.action.kind == .bash)
        } else {
            Issue.record("Expected Codex exec to normalize through provider")
        }
    }

    @Test func treatsUnsupportedPartsAsGroupingBoundaries() {
        let items = builder.build(
            message: message(parts: [
                tool("Read", callId: "read-1", input: ["file_path": .string("/a.swift")]),
                .data(.init(type: "data-status", data: .object(["value": .string("boundary")]))),
                tool("Read", callId: "read-2", input: ["file_path": .string("/b.swift")])
            ]),
            providerId: .claudeCode
        )

        #expect(items.count == 2)
        #expect(items.map(\.key) == [
            "m1-actions-0-0-single-read-1",
            "m1-actions-2-0-single-read-2"
        ])
    }

    @Test func findsFinalResponseStartAfterWorkTrace() {
        let message = message(parts: [
            .reasoning(.init(text: "thinking")),
            tool("Read", callId: "read-1", input: ["file_path": .string("/a.swift")]),
            .text(.init(text: "Final answer"))
        ])
        let items = builder.build(message: message, providerId: .claudeCode)

        #expect(builder.finalResponseStartIndex(renderItems: items) == 2)
    }

    @Test func doesNotFindFinalResponseStartForAllTextTranscript() {
        let message = message(parts: [
            .text(.init(text: "First")),
            .text(.init(text: "Second"))
        ])
        let items = builder.build(message: message, providerId: .claudeCode)

        #expect(builder.finalResponseStartIndex(renderItems: items) == nil)
    }

    @Test func findsLastTextAfterWorkTrace() {
        let message = message(parts: [
            tool("Read", callId: "read-1", input: ["file_path": .string("/a.swift")]),
            .text(.init(text: "First answer")),
            tool("Read", callId: "read-2", input: ["file_path": .string("/b.swift")]),
            .text(.init(text: "Final answer"))
        ])
        let items = builder.build(message: message, providerId: .claudeCode)

        #expect(builder.finalResponseStartIndex(renderItems: items) == 3)
    }

    private func editInput(path: String, from oldString: String, to newString: String) -> [String: JSONValue] {
        [
            "file_path": .string(path),
            "old_string": .string(oldString),
            "new_string": .string(newString)
        ]
    }

    private func message(
        id: String = "m1",
        role: SessionMessage.Role = .assistant,
        parts: [SessionMessage.Part]
    ) -> SessionMessage {
        SessionMessage(id: id, role: role, parts: parts)
    }

    private func groupedActionItem(parts: [SessionMessage.Part]) -> AgentSessionRenderItem.ActionItem? {
        let items = builder.build(
            message: message(parts: parts),
            providerId: .claudeCode
        )
        guard case .actionItem(let item) = items.first else {
            Issue.record("Expected action item")
            return nil
        }
        return item
    }

    private func singleActionItem(part: SessionMessage.Part) -> AgentSessionRenderItem.ActionItem? {
        let items = builder.build(
            message: message(parts: [part]),
            providerId: .claudeCode
        )
        guard case .actionItem(let item) = items.first else {
            Issue.record("Expected action item")
            return nil
        }
        return item
    }

    private func tool(
        _ toolName: String,
        callId: String,
        state: String = "output-available",
        input: [String: JSONValue] = [:],
        output: JSONValue? = nil
    ) -> SessionMessage.Part {
        .dynamicTool(.init(
            toolName: toolName,
            toolCallId: callId,
            state: state,
            input: .object(input),
            output: output
        ))
    }
}

private extension AgentSessionRenderItem.ActionItem {
    var isSingle: Bool {
        if case .single = self { return true }
        return false
    }
}
