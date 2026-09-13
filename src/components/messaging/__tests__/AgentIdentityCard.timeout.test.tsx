import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentIdentityCard } from "@/components/messaging/agent-settings/AgentIdentityCard";
import type { AiAgentConfigInput } from "@/hooks/useAiAgentConfig";
import type { AgentBehavior } from "@/lib/agentProfile";

function renderCard(formOverrides: Partial<AiAgentConfigInput> = {}, update = vi.fn()) {
  const form: AiAgentConfigInput = {
    is_enabled: true,
    default_mode: "human_then_ai",
    escalation_timeout_minutes: 240,
    language_mode: "auto",
    persona_instructions: "",
    business_profile_text: "",
    ...formOverrides,
  };
  const behavior: AgentBehavior = {};
  const updateBehavior = vi.fn();

  const rendered = render(
    <AgentIdentityCard
      form={form}
      update={update}
      behavior={behavior}
      updateBehavior={updateBehavior}
    />,
  );
  return { ...rendered, form, update, behavior, updateBehavior };
}

async function switchToHours() {
  const trigger = screen.getByRole("combobox", { name: "Timeout unit" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: "Hours" }));
}

describe("AgentIdentityCard escalation timeout", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("the timeout control is hidden for human_first and shown for the other modes", () => {
    const r1 = renderCard({ default_mode: "human_first" });
    expect(screen.queryByLabelText("Escalation fallback timeout")).not.toBeInTheDocument();
    r1.unmount();

    const r2 = renderCard({ default_mode: "ai_first" });
    expect(screen.getByLabelText("Escalation fallback timeout")).toBeInTheDocument();
    r2.unmount();

    renderCard({ default_mode: "human_then_ai" });
    expect(screen.getByLabelText("Escalation fallback timeout")).toBeInTheDocument();
  });

  it("hours are stored as minutes", () => {
    const update = vi.fn();
    renderCard({ default_mode: "human_then_ai", escalation_timeout_minutes: 240 }, update);

    const input = screen.getByLabelText("Escalation fallback timeout") as HTMLInputElement;
    expect(input.value).toBe("4");
    expect(screen.getByRole("combobox", { name: "Timeout unit" })).toHaveTextContent("Hours");

    fireEvent.change(input, { target: { value: "2" } });
    expect(update).toHaveBeenCalledWith("escalation_timeout_minutes", 120);
  });

  it("switching the unit never changes the stored value", async () => {
    for (const { minutes, expectedHours } of [
      { minutes: 1, expectedHours: "0.02" },
      { minutes: 30, expectedHours: "0.5" },
      { minutes: 90, expectedHours: "1.5" },
    ]) {
      const update = vi.fn();
      renderCard({ default_mode: "human_then_ai", escalation_timeout_minutes: minutes }, update);

      const input = screen.getByLabelText("Escalation fallback timeout") as HTMLInputElement;
      expect(input.value).toBe(String(minutes));
      expect(screen.getByRole("combobox", { name: "Timeout unit" })).toHaveTextContent("Minutes");

      await switchToHours();

      expect(update).not.toHaveBeenCalled();
      expect(input.value).toBe(expectedHours);
      cleanup();
    }
  });
});
