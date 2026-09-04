import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for the 2026-08-30 outage. The user typed a persona for an
// account with no config yet; the Knowledge tab's save created the row and
// invalidated the shared cache entry; the settling read handed the effect a real
// config object, which overwrote what they had typed. Save then wrote blanks --
// with every existing guard satisfied, including the one added after the
// 2026-08-28 outage.
//
// The transition that matters is null -> object. A test that leaves the mocked
// config null across the rerender proves nothing: null is a primitive, its
// identity is stable, the effect deps never change, and the typed persona
// survives with the bug fully present.

const upsertConfig = { mutate: vi.fn(), isPending: false };

/** Mutated by each test to drive the read's settled value across a rerender. */
let configValue: null | Record<string, unknown> = null;

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({
    // A NEW object identity each render when non-null, exactly as React Query
    // yields after an invalidation.
    config: configValue === null ? null : { ...configValue },
    isLoading: false,
    error: null,
    upsertConfig,
  }),
}));

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [
      { id: "a1", platform: "facebook", platform_username: "Eltamlawy", is_active: true },
    ],
  }),
}));

vi.mock("@/components/messaging/AutomationHandlerCard", () => ({
  AutomationHandlerCard: () => null,
}));
vi.mock("@/components/messaging/AiKnowledgeManager", () => ({ AiKnowledgeManager: () => null }));
vi.mock("@/components/messaging/AiAgentLogsView", () => ({ AiAgentLogsView: () => null }));
vi.mock("@/components/messaging/AiAgentTestChat", () => ({ AiAgentTestChat: () => null }));
vi.mock("@/components/messaging/AutoReplyManager", () => ({ AutoReplyManager: () => null }));
vi.mock("@/components/automation/DatabaseConnectorsManager", () => ({
  DatabaseConnectorsManager: () => null,
}));

import { AiAgentManager } from "@/components/messaging/AiAgentManager";

const persona = () =>
  screen.getByLabelText("Persona and instructions") as HTMLTextAreaElement;

describe("AiAgentManager blank-save regression", () => {
  beforeEach(() => {
    upsertConfig.mutate.mockClear();
    configValue = null;
  });

  it("keeps typed edits when the same account's config arrives from another tab's save", () => {
    const { rerender } = render(<AiAgentManager platform="facebook" />);

    fireEvent.change(persona(), { target: { value: "Eltamlawy brand voice" } });

    // The Knowledge tab saved a business profile. That created the config row and
    // invalidated the shared cache entry, so this query now settles with a real
    // object where it previously held null. The ACCOUNT did not change.
    configValue = {
      persona_instructions: "",
      business_profile_text: "Saved from the other tab",
    };
    rerender(<AiAgentManager platform="facebook" />);

    expect(persona().value).toBe("Eltamlawy brand voice");

    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(upsertConfig.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ persona_instructions: "Eltamlawy brand voice" }),
      expect.anything(),
    );
  });

  it("marks a user-initiated clear as deliberate", () => {
    // The server refuses a blanking write unless it is declared. A reset cannot
    // reach here saying yes -- a reset sets form AND baseline together, so the
    // baseline is blank too and the comparison is false. Only a user who saw a
    // value and deleted it produces a non-empty baseline against an empty form.
    configValue = { persona_instructions: "Loaded brand voice", is_enabled: true };
    render(<AiAgentManager platform="facebook" />);

    fireEvent.change(persona(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    expect(upsertConfig.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ persona_instructions: "", confirm_clear: true }),
      expect.anything(),
    );
  });

  it("does not declare a clear when nothing was stored", () => {
    // A first save with an empty box is not a deletion, and marking it as one
    // would train the guard to be ignored.
    render(<AiAgentManager platform="facebook" />);
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    expect(upsertConfig.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ confirm_clear: undefined }),
      expect.anything(),
    );
  });
  it("picks up a field refreshed elsewhere while keeping edited ones", () => {
    // Codex P1. Freezing the whole form on a repeat read is the opposite mistake
    // to resetting it, and just as lossy: another surface's save refreshes this
    // same query, so a frozen form would carry stale server values and the next
    // Settings save would write them back over what was just stored.
    //
    // The vehicle used to be business_profile_text, which this form no longer
    // holds -- see the absence assertion below, which is now the stronger form
    // of the same protection. agent_behavior replaces it as the untouched field,
    // and being an object it also exercises the JSON.stringify comparison that
    // mergeUntouchedFields and useDirtyForm both depend on.
    configValue = { persona_instructions: "Original", agent_behavior: { tone: "formal" } };
    const { rerender } = render(<AiAgentManager platform="facebook" />);

    fireEvent.change(persona(), { target: { value: "Edited persona" } });

    // Another session saved a new behavior; this query refetched.
    configValue = { persona_instructions: "Original", agent_behavior: { tone: "concise" } };
    rerender(<AiAgentManager platform="facebook" />);

    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(upsertConfig.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        persona_instructions: "Edited persona",     // the user's edit survives
        agent_behavior: { tone: "concise" },        // the untouched field follows the server
      }),
      expect.anything(),
    );
  });

  it("never writes business_profile_text, which the knowledge tab owns", () => {
    // The structural close of the hazard the test above was written for. This
    // form has no UI for the business profile, so echoing the server's derived
    // text back on every save was a write with no author -- and once the
    // knowledge tab writes STRUCTURE that the server renders into that column,
    // a Settings save carrying stale text would desync the two.
    configValue = { persona_instructions: "Original", business_profile_text: "Owned elsewhere" };
    render(<AiAgentManager platform="facebook" />);

    fireEvent.change(persona(), { target: { value: "Edited persona" } });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    const [payload] = upsertConfig.mutate.mock.calls.at(-1) as [Record<string, unknown>];
    expect("business_profile_text" in payload).toBe(false);
  });
  it("does nothing when a repeat read brings no new values", () => {
    // Idempotence, and it is not cosmetic. Both setters build fresh objects, so
    // an unconditional merge re-renders; the mock above spreads `config` on every
    // render, so without the equality guard this effect re-enters itself forever.
    // That loop hung a CI job for two hours. The mock deliberately keeps the
    // per-render identity change rather than hiding it.
    configValue = { persona_instructions: "Stable", agent_behavior: { tone: "formal" } };
    const { rerender } = render(<AiAgentManager platform="facebook" />);

    for (let i = 0; i < 5; i += 1) rerender(<AiAgentManager platform="facebook" />);

    expect(persona().value).toBe("Stable");
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(upsertConfig.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        persona_instructions: "Stable",
        agent_behavior: { tone: "formal" },
      }),
      expect.anything(),
    );
  });
});
