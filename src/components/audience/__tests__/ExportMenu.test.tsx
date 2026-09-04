import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchAllContacts = vi.fn();
const downloadBlob = vi.fn();
vi.mock("@/features/audience", async () => {
  const actual = await vi.importActual<typeof import("@/features/audience")>("@/features/audience");
  return { ...actual, fetchAllContacts: (...a: unknown[]) => fetchAllContacts(...a), downloadBlob: (...a: unknown[]) => downloadBlob(...a) };
});

import { ExportMenu } from "../ExportMenu";
import { EMPTY_FILTERS } from "@/features/audience";

beforeEach(() => { fetchAllContacts.mockReset(); downloadBlob.mockReset(); });

describe("ExportMenu", () => {
  it("downloads the filtered rows as CSV", async () => {
    fetchAllContacts.mockResolvedValue({ truncated: false, cap: 5000, rows: [{ platform: "threads", display_name: "V", username: "v", platform_user_id: "v", email: null, phone_number: null, company: null, source: "organic_comment", tags: [], total_comments_count: 1, first_interacted_at: "a", last_interacted_at: "b", notes: null }] });
    render(<ExportMenu filters={{ ...EMPTY_FILTERS, platform: "threads" }} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(await screen.findByText("Full CSV"));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    expect(fetchAllContacts).toHaveBeenCalledWith({ ...EMPTY_FILTERS, platform: "threads" });
    const [blob, name] = downloadBlob.mock.calls[0];
    expect(name).toMatch(/^audience-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = await (blob as Blob).text();
    const [header, dataLine] = csv.split("\r\n");
    expect(header.split(",")).toContain("display_name");
    expect(dataLine.split(",")).toContain("threads");
    expect(dataLine.split(",")).toContain("V");
  });

  it("downloads the Meta custom-audience CSV with its own filename", async () => {
    fetchAllContacts.mockResolvedValue({ truncated: false, cap: 5000, rows: [{ platform: "facebook", display_name: "Sara Ahmed", username: null, platform_user_id: "102227720640048", email: "Sara@Example.com", phone_number: null, company: null, source: "organic_comment", tags: [], total_comments_count: 1, first_interacted_at: "a", last_interacted_at: "b", notes: null }] });
    render(<ExportMenu filters={EMPTY_FILTERS} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(await screen.findByText("Meta Custom Audience CSV"));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const [blob, name] = downloadBlob.mock.calls[0];
    expect(name).toMatch(/^meta-audience-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(await (blob as Blob).text()).toContain("sara@example.com,,Sara,Ahmed,102227720640048");
  });
});
