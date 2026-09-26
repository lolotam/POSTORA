import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { renderMinimal } from "@/test/test-utils";
import { SavedTestsPanel } from "../SavedTestsPanel";
import type { TestCase } from "../../domain/types";

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

vi.mock("../../infrastructure/testCasesApi", () => api);
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

const cases: TestCase[] = [
  {
    id: "c1",
    userId: "user-1",
    socialAccountId: "acct",
    platform: "whatsapp",
    message: "first question",
    expected: { contains: ["د.ك"] },
    position: 0,
    expectationValid: true,
  },
  {
    id: "c2",
    userId: "user-1",
    socialAccountId: "acct",
    platform: "whatsapp",
    message: "second question",
    expected: { escalates: true },
    position: 1,
    expectationValid: true,
  },
];

describe("SavedTestsPanel", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18next.changeLanguage("en");
    api.listTestCases.mockResolvedValue(cases);
    api.listTestRuns.mockResolvedValue([]);
    api.insertRun.mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    api.updateRun.mockResolvedValue(undefined);
    api.deleteRunThreads.mockResolvedValue(undefined);
    api.runTestCase
      .mockResolvedValueOnce({
        ok: true,
        reply: "no price here",
        intent_status: "classified",
        intent: { choice: "pricing", confidence: 0.91 },
        tool_calls: [],
        escalated: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        reply: "I will hand this over",
        intent_status: "off",
        tool_calls: [],
        escalated: true,
      });
  });

  it("runs every case in order and shows a failure without stopping", async () => {
    renderMinimal(<SavedTestsPanel platform="whatsapp" accountId="acct" />);
    expect(await screen.findByText("first question")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));

    await waitFor(() => expect(api.runTestCase).toHaveBeenCalledTimes(2));
    expect(api.runTestCase.mock.calls.map((call) => call[0].message)).toEqual([
      "first question",
      "second question",
    ]);
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText('reply does not contain "د.ك"')).toBeInTheDocument();
  });

  it("closes and clears the editor when the account changes", async () => {
    const view = renderMinimal(<SavedTestsPanel platform="whatsapp" accountId="acct-a" />);
    expect(await screen.findByText("first question")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByLabelText("Customer message")).toHaveValue("first question");

    view.rerender(<SavedTestsPanel platform="whatsapp" accountId="acct-b" />);

    await waitFor(() => {
      expect(screen.queryByLabelText("Customer message")).not.toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue("first question")).not.toBeInTheDocument();
  });
});
