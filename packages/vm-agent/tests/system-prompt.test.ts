import { describe, expect, it } from "vitest";
import { buildSystemPromptAppend } from "../src/lib/system-prompt";

describe("buildSystemPromptAppend", () => {
  it("includes sprite context, branch naming instructions, and Claude todo guidance", () => {
    const prompt = buildSystemPromptAppend("abcd", "Sprite-specific context", "TaskCreate");

    expect(prompt).toContain("Sprite-specific context");
    expect(prompt).toContain("mymachines/<descriptive-slug>-abcd");
    expect(prompt).toContain("NEVER push to `main`");
    expect(prompt).toContain("automatically creates a pull request");
    expect(prompt).toContain("Use checkpoint tooling silently");
    expect(prompt).toContain("unless the user explicitly asks about checkpoint status");
    expect(prompt).toContain("`TaskCreate`");
    expect(prompt).toContain("`TaskUpdate`");
    expect(prompt).toContain("`TaskList`");
    expect(prompt).toContain("`TaskGet`");
  });

  it("mentions update_plan for Codex", () => {
    const prompt = buildSystemPromptAppend("wxyz", "Sprite-specific context", "update_plan");

    expect(prompt).toContain("`update_plan`");
  });
});
