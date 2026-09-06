import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { connectedKey, fakeGateway, model, queryWrapper } from "../tests/fixtures";
import { AiRoutingCard } from "./AiRoutingCard";

async function select(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
async function mount(gateway = fakeGateway()) {
  render(<AiRoutingCard gateway={gateway} userId="user-1" />, queryWrapper());
  await screen.findByRole("region", { name: "Global routing" });
  return gateway;
}

describe("Routing", () => {
  it("requires fallback consent and saves true only for user_first", async () => {
    const gateway = await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Use my keys first, then POSTORA" }));
    await select("* provider", "OpenAI");
    await select("* model", "Test model");
    const save = screen.getByRole("button", { name: "Save routing" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "If my key fails or is invalid, run the request on POSTORA's providers and quota instead." }));
    fireEvent.click(save);
    await waitFor(() => expect(gateway.upsertPreference).toHaveBeenCalledWith({ capability: "*", mode: "user_first", preferred_provider_code: "openai", preferred_model_id: model.model_id, allow_platform_fallback: true }));
  });
  it("hides consent for user_only and saves false", async () => {
    const gateway = await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Use only my keys" }));
    await select("* provider", "OpenAI");
    await select("* model", "Test model");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
    await waitFor(() => expect(gateway.upsertPreference).toHaveBeenCalledWith(expect.objectContaining({ mode: "user_only", allow_platform_fallback: false })));
  });
  it("offers only connected providers, excluding invalid and absent keys", async () => {
    const gateway = fakeGateway();
    gateway.listKeys.mockResolvedValue([connectedKey, { ...connectedKey, provider_code: "claude", status: "invalid" }]);
    await mount(gateway);
    fireEvent.click(screen.getByRole("radio", { name: "Use only my keys" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "* provider" }), { key: "Enter" });
    expect(await screen.findAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "OpenAI" })).toBeInTheDocument();
  });
  it("saves a Chat override and Follow global deletes only that capability", async () => {
    const gateway = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Chat (captions & hashtags)" }));
    const chat = within(screen.getByRole("region", { name: "Chat (captions & hashtags)" }));
    fireEvent.click(chat.getByRole("radio", { name: "Use POSTORA providers" }));
    fireEvent.click(chat.getByRole("button", { name: "Save routing" }));
    await waitFor(() => expect(gateway.upsertPreference).toHaveBeenCalledExactlyOnceWith({ capability: "chat", mode: "postora_only", preferred_provider_code: null, preferred_model_id: null, allow_platform_fallback: false }));
    await waitFor(() => expect(chat.getByRole("button", { name: "Save routing" })).toBeEnabled());
    fireEvent.click(chat.getByRole("radio", { name: "Follow global" }));
    fireEvent.click(chat.getByRole("button", { name: "Save routing" }));
    await waitFor(() => expect(gateway.deletePreference).toHaveBeenCalledExactlyOnceWith("chat"));
    expect(gateway.upsertPreference).toHaveBeenCalledTimes(1);
  });
  it("does not render writable defaults after a failed preferences read", async () => {
    const gateway = fakeGateway();
    gateway.getPreferences.mockRejectedValue(new Error("read failed"));
    render(<AiRoutingCard gateway={gateway} userId="user-1" />, queryWrapper());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load routing settings");
    expect(screen.queryByRole("button", { name: "Save routing" })).not.toBeInTheDocument();
  });
});
