import { describe, expect, it } from "vitest";
import { filterActivity, type AgentActivity } from "@/hooks/useAgentActivity";

const postora = (id: string, createdAt: string): AgentActivity => ({
  source: "postora",
  id: `postora-${id}`,
  createdAt,
  log: {
    id,
    platform: "facebook",
    conversation_id: "conv-1",
    inbound_text: "hi",
    reply_text: "hello",
    tool_calls: null,
    prompt_tokens: null,
    completion_tokens: null,
    latency_ms: null,
    status: "sent",
    error: null,
    created_at: createdAt,
  },
});

const n8n = (id: string, createdAt: string): AgentActivity => ({
  source: "n8n",
  id: `n8n-${id}`,
  createdAt,
  dispatch: {
    id,
    platform: "facebook",
    event: "message.received",
    conversation_id: "conv-1",
    inbound_text: "hi",
    destination_count: 1,
    created_at: createdAt,
  },
});

describe("filterActivity", () => {
  const entries = [
    n8n("b", "2026-08-27T12:00:00Z"),
    postora("a", "2026-08-27T11:00:00Z"),
    n8n("c", "2026-08-27T10:00:00Z"),
  ];

  it("keeps everything under 'all'", () => {
    expect(filterActivity(entries, "all")).toHaveLength(3);
  });

  it("narrows to the engine that produced the entry", () => {
    expect(filterActivity(entries, "postora").map((e) => e.id)).toEqual(["postora-a"]);
    expect(filterActivity(entries, "n8n").map((e) => e.id)).toEqual(["n8n-b", "n8n-c"]);
  });

  it("preserves the merged time ordering", () => {
    expect(filterActivity(entries, "all").map((e) => e.id)).toEqual([
      "n8n-b",
      "postora-a",
      "n8n-c",
    ]);
  });

  // The ids are prefixed because the two tables have independent uuid spaces and React
  // would silently reuse a row if the same uuid appeared in both.
  it("gives the two sources distinct keys", () => {
    const collision = [postora("same-uuid", "2026-08-27T12:00:00Z"), n8n("same-uuid", "2026-08-27T12:00:00Z")];
    expect(new Set(collision.map((e) => e.id)).size).toBe(2);
  });

  it("returns nothing when a source has no entries", () => {
    expect(filterActivity([], "n8n")).toEqual([]);
  });
});
