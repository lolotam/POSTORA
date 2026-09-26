import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { renderMinimal } from "@/test/test-utils";
import { AiAgentTestChat } from "../AiAgentTestChat";

const edge = vi.hoisted(() => ({ callEdgeApi: vi.fn() }));
const api = vi.hoisted(() => ({
  listTestCases: vi.fn(),
  listTestRuns: vi.fn(),
  insertTestCase: vi.fn(),
  updateTestCase: vi.fn(),
  deleteTestCase: vi.fn(),
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  deleteRunThreads: vi.fn(),
  runTestCase: vi.fn(),
}));

vi.mock("@/lib/messagingApi", () => edge);
vi.mock("@/features/agent-tests/infrastructure/testCasesApi", () => api);
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

describe("AiAgentTestChat saved tests", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18next.changeLanguage("en");
    api.listTestCases.mockResolvedValue([]);
    api.listTestRuns.mockResolvedValue([]);
    edge.callEdgeApi.mockResolvedValue({ reply: "the price is 5", tool_calls: [], escalated: false });
  });

  it("prefills Save as test with only the customer message", async () => {
    renderMinimal(<AiAgentTestChat platform="whatsapp" accountId="acct-1" />);
    const input = screen.getByPlaceholderText(/كم سعر التوصيل/);
    fireEvent.change(input, { target: { value: "كم السعر؟" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("the price is 5")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save as test" }));

    expect(await screen.findByLabelText("Customer message")).toHaveValue("كم السعر؟");
    expect(screen.getByText("This runs as a new customer, without earlier messages.")).toBeInTheDocument();
  });

  it("clears the chat when the account changes", async () => {
    const view = renderMinimal(<AiAgentTestChat platform="whatsapp" accountId="acct-1" />);
    const input = screen.getByPlaceholderText(/كم سعر التوصيل/);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("the price is 5")).toBeInTheDocument();

    view.rerender(<AiAgentTestChat platform="whatsapp" accountId="acct-2" />);
    await waitFor(() => expect(screen.queryByText("the price is 5")).not.toBeInTheDocument());
  });

  it("drops a reply that resolves after the account changes", async () => {
    let resolveSend: (value: { reply: string; tool_calls: []; escalated: boolean }) => void = () => {};
    edge.callEdgeApi.mockImplementation(
      () => new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    const view = renderMinimal(<AiAgentTestChat platform="whatsapp" accountId="acct-1" />);
    const input = screen.getByPlaceholderText(/كم سعر التوصيل/);
    fireEvent.change(input, { target: { value: "hello from A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(edge.callEdgeApi).toHaveBeenCalledTimes(1));

    view.rerender(<AiAgentTestChat platform="whatsapp" accountId="acct-2" />);
    await act(async () => {
      resolveSend({ reply: "late reply for A", tool_calls: [], escalated: false });
    });

    expect(screen.queryByText("hello from A")).not.toBeInTheDocument();
    expect(screen.queryByText("late reply for A")).not.toBeInTheDocument();
    expect(screen.getByText("Send a message the way a customer would — in Arabic or English.")).toBeInTheDocument();
  });
});
