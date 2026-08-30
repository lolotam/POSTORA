import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Cross-account sharing: one indexed file, readable by several agents.
//
// The dangerous part is not the checkbox, it is the write.
// set_ai_knowledge_source_visibility REPLACES a source's whole link set, so
// every toggle has to send the complete desired list. Sending a delta -- or the
// literal contents of the link table for a source that is 'shared' and
// therefore has NO link rows -- silently strips the source from every other
// agent. These tests assert the payload, not the tick.

const upsertConfig = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
const invoke = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({ config: null, error: null, upsertConfig }),
}));

let knowledge = {
  sources: [] as Record<string, unknown>[],
  links: [] as Record<string, unknown>[],
  linksReady: true,
  linksError: null as unknown,
};

vi.mock("@/hooks/useAiKnowledge", () => ({
  useAiKnowledge: () => ({
    user: { id: "u1" },
    sources: knowledge.sources,
    links: knowledge.links,
    linksReady: knowledge.linksReady,
    linksError: knowledge.linksError,
    isLoading: false,
    graphExport: { data: null },
    invoke,
    resolveExportUrls: { mutateAsync: vi.fn() },
  }),
}));
vi.mock("@/hooks/useWhatsAppCatalog", () => ({
  useWhatsAppCatalog: () => ({ waAccount: null, catalog: null }),
}));

const ACCOUNTS = [
  { id: "fb-1", platform: "facebook", platform_username: "Page A", platform_user_id: null },
  { id: "ig-1", platform: "instagram", platform_username: "xsellpoint_kw", platform_user_id: null },
  { id: "th-1", platform: "threads", platform_username: "Xsellpoint", platform_user_id: null },
  // No agent runs on TikTok, so it must not get a checkbox -- the box would
  // promise retrieval that can never happen.
  { id: "tt-1", platform: "tiktok", platform_username: "xsellpoint_on_tiktok", platform_user_id: null },
];
let accounts = {
  data: ACCOUNTS as Record<string, unknown>[] | undefined,
  isSuccess: true,
  error: null as unknown,
};
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => accounts,
}));

import { AiKnowledgeManager } from "@/components/messaging/AiKnowledgeManager";

const source = (visibility: "shared" | "restricted") => ({
  id: "s1",
  file_name: "price-list.md",
  source_type: "doc",
  status: "ready",
  visibility,
  chunk_count: 12,
});

// Anchored to the end of the accessible name ("Share <file> with <account>").
// Unanchored, "Xsellpoint" also matches "xsellpoint_kw" and the query resolves
// to two boxes -- so a real handle and a prefix of it could never be told apart.
const shareBox = (name: string) =>
  screen.getByRole("checkbox", { name: new RegExp(`with ${name}$`, "i") });

describe("AiKnowledgeManager cross-account sharing", () => {
  beforeEach(() => {
    invoke.mutateAsync.mockClear();
    knowledge = { sources: [], links: [], linksReady: true, linksError: null };
    accounts = { data: ACCOUNTS, isSuccess: true, error: null };
  });

  it("offers only the platforms an agent actually runs on", () => {
    knowledge.sources = [source("restricted")];
    knowledge.links = [{ source_id: "s1", social_account_id: "fb-1" }];
    render(<AiKnowledgeManager platform="facebook" accountId="fb-1" />);

    // By role, not by rendered text. The three handles here overlap by prefix
    // and by case on purpose: a getByText("xsellpoint") would have "proved"
    // TikTok's absence while actually just missing on capitalisation.
    expect(shareBox("xsellpoint_kw")).toBeTruthy();
    expect(shareBox("Xsellpoint")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /with xsellpoint_on_tiktok$/i })).toBeNull();
  });

  it("shares an already-indexed file with another platform without re-uploading", () => {
    knowledge.sources = [source("restricted")];
    knowledge.links = [{ source_id: "s1", social_account_id: "fb-1" }];
    render(<AiKnowledgeManager platform="facebook" accountId="fb-1" />);

    fireEvent.click(shareBox("xsellpoint_kw"));

    // The Facebook link survives, Instagram joins it, and no ingest action is
    // dispatched: the chunks are already embedded.
    expect(invoke.mutateAsync).toHaveBeenCalledWith({
      action: "set_source_visibility",
      source_id: "s1",
      visibility: "restricted",
      social_account_ids: ["fb-1", "ig-1"],
    });
  });

  it("unticking one box on a shared source keeps every other agent", () => {
    // The regression this file exists for. A 'shared' source has zero link
    // rows; writing "the links minus the unticked one" would send [] and hide
    // the file from all three agents at once.
    knowledge.sources = [source("shared")];
    knowledge.links = [];
    render(<AiKnowledgeManager platform="facebook" accountId="fb-1" />);

    fireEvent.click(shareBox("xsellpoint_kw"));

    expect(invoke.mutateAsync).toHaveBeenCalledWith({
      action: "set_source_visibility",
      source_id: "s1",
      visibility: "restricted",
      social_account_ids: ["fb-1", "th-1"],
    });
  });

  it("refuses to untick the last account instead of stranding the source", () => {
    // Restricted with no links is readable by nobody AND listable by nobody, so
    // the strip that could undo it would never be drawn again.
    knowledge.sources = [source("restricted")];
    knowledge.links = [{ source_id: "s1", social_account_id: "fb-1" }];
    render(<AiKnowledgeManager platform="facebook" accountId="fb-1" />);

    fireEvent.click(shareBox("Page A"));

    expect(invoke.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not draw the strip before the links have loaded", () => {
    // Every box would render unticked, and a click would write that fiction
    // back as though the user had chosen it.
    knowledge.sources = [source("restricted")];
    knowledge.links = [];
    knowledge.linksReady = false;
    render(<AiKnowledgeManager platform="facebook" accountId="fb-1" />);

    expect(screen.queryByRole("checkbox", { name: /with xsellpoint_kw/i })).toBeNull();
  });

  it("says the accounts read failed instead of showing no one to share with", () => {
    // A failed read leaves `data` undefined, and the component's `= []` default
    // makes that indistinguishable from "no connected accounts" -- which would
    // remove the strip silently and report sharing as unavailable rather than
    // as unknown.
    knowledge.sources = [source("restricted")];
    knowledge.links = [{ source_id: "s1", social_account_id: "fb-1" }];
    accounts = { data: undefined, isSuccess: false, error: new Error("network") };
    render(<AiKnowledgeManager platform="facebook" accountId="fb-1" />);

    expect(screen.getByText(/could not load your connected accounts/i)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // And the badge must not turn the missing list into a count of zero.
    expect(screen.getByText("Some accounts")).toBeTruthy();
  });

  it("keeps one source's boxes disabled while a different source is written", async () => {
    // Codex P1. A single in-flight id was overwritten by the second toggle,
    // re-enabling the first source's boxes mid-write; a click there would then
    // compute its full replacement set from pre-refetch links and discard the
    // change still in flight.
    let releaseFirst: () => void = () => {};
    invoke.mutateAsync.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    knowledge.sources = [source("restricted"), { ...source("restricted"), id: "s2" }];
    knowledge.links = [
      { source_id: "s1", social_account_id: "fb-1" },
      { source_id: "s2", social_account_id: "fb-1" },
    ];
    render(<AiKnowledgeManager platform="facebook" accountId="fb-1" />);

    const [firstIg, secondIg] = screen.getAllByRole("checkbox", {
      name: /with xsellpoint_kw$/i,
    });
    fireEvent.click(firstIg);
    fireEvent.click(secondIg);

    // s1 is still writing, so its boxes stay disabled even though s2 started after.
    expect(firstIg).toBeDisabled();

    releaseFirst();
    await vi.waitFor(() => expect(firstIg).not.toBeDisabled());
  });
});
