import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
});
