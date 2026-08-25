import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { unzipSync, strFromU8 } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppInboxApi } from "./ports";
import { useConversationExport } from "./useConversationExport";
import { WhatsAppInboxApiProvider } from "../ui/WhatsAppInboxApiProvider";

interface Downloaded {
  blob: Blob;
  filename: string;
}

function messageAt(index: number) {
  return {
    id: `row-${index}`,
    message: `hello ${index}`,
    from: { name: "Customer", id: "96551111111" },
    to: [{ name: "", id: "96550000000" }],
    created_time: new Date(Date.UTC(2026, 7, 24, 9, index % 60)).toISOString(),
    direction: "inbound",
    status: "received",
    provider_message_id: `WAMID-${index}`,
    media_understanding: null,
    attachments: [],
  };
}

function makeApi(overrides: Partial<WhatsAppInboxApi>, downloads: Downloaded[]): WhatsAppInboxApi {
  return {
    getMessagesPage: vi.fn(async () => ({ messages: [messageAt(1)], page_info: { next_before: null, has_more: false } })),
    getMedia: vi.fn(async () => ({ media: [] })),
    downloadBlob: vi.fn((blob: Blob, filename: string) => downloads.push({ blob, filename })),
    ...overrides,
  } as unknown as WhatsAppInboxApi;
}

function wrapperFor(api: WhatsAppInboxApi) {
  return ({ children }: { children: ReactNode }) => (
    <WhatsAppInboxApiProvider api={api}>{children}</WhatsAppInboxApiProvider>
  );
}

const chat = (id: string, name: string) => ({
  conversationId: id,
  participantName: name,
  participantPhone: "96551111111",
});

describe("useConversationExport", () => {
  let downloads: Downloaded[];

  beforeEach(() => {
    downloads = [];
  });

  it("stops paging when has_more is false", async () => {
    const api = makeApi({}, downloads);
    const { result } = renderHook(() => useConversationExport(), { wrapper: wrapperFor(api) });

    await act(async () => {
      await result.current.runExport({
        socialAccountId: "acct",
        accountLabel: "Support",
        chats: [chat("conv-1", "Customer")],
        format: "md",
        includeMedia: false,
        exportedAt: new Date("2026-08-25T10:00:00.000Z"),
      });
    });

    expect(api.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toMatch(/\.md$/);
  });

  // The rendered store only holds what the user scrolled through. An export that read from it
  // would silently ship a fraction of the thread, so the loop must walk the cursor to the end.
  it("walks every page rather than exporting the loaded window", async () => {
    let page = 0;
    const api = makeApi({
      getMessagesPage: vi.fn(async () => {
        page += 1;
        return {
          messages: [messageAt(page)],
          page_info: page < 3
            ? { next_before: { timestamp: `2026-08-2${page}T00:00:00.000Z`, id: `row-${page}` }, has_more: true }
            : { next_before: null, has_more: false },
        };
      }),
    }, downloads);
    const { result } = renderHook(() => useConversationExport(), { wrapper: wrapperFor(api) });

    await act(async () => {
      await result.current.runExport({
        socialAccountId: "acct",
        accountLabel: "Support",
        chats: [chat("conv-1", "Customer")],
        format: "md",
        includeMedia: false,
        exportedAt: new Date("2026-08-25T10:00:00.000Z"),
      });
    });

    expect(api.getMessagesPage).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(result.current.progress?.chats[0].messagesFetched).toBe(3));
  });

  it("produces a readable zip with one markdown file per chat when several are selected", async () => {
    const api = makeApi({}, downloads);
    const { result } = renderHook(() => useConversationExport(), { wrapper: wrapperFor(api) });

    await act(async () => {
      await result.current.runExport({
        socialAccountId: "acct",
        accountLabel: "Support",
        chats: [chat("conv-1", "Ahmed"), chat("conv-2", "Sara")],
        format: "md",
        includeMedia: false,
        exportedAt: new Date("2026-08-25T10:00:00.000Z"),
      });
    });

    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toMatch(/\.zip$/);
    const bytes = new Uint8Array(await downloads[0].blob.arrayBuffer());
    const entries = unzipSync(bytes);
    const names = Object.keys(entries);
    expect(names.some((name) => name.endsWith("README.md"))).toBe(true);
    expect(names.filter((name) => /Ahmed|Sara/.test(name))).toHaveLength(2);
    expect(strFromU8(entries[names.find((n) => n.includes("Ahmed")) as string])).toContain("participant:");
  });

  // A single unreachable photo must never cost the user a transcript of thousands of messages.
  it("still produces an archive when a media download fails, and records the miss", async () => {
    const api = makeApi({
      getMessagesPage: vi.fn(async () => ({
        messages: [{
          ...messageAt(1),
          attachments: [{ kind: "image", message_row_id: "row-1", mime_type: "image/jpeg", name: null }],
        }],
        page_info: { next_before: null, has_more: false },
      })),
      getMedia: vi.fn(async () => ({
        media: [{ message_row_id: "row-1", kind: "image", url: "https://signed.example/x.jpg" }],
      })),
    }, downloads);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const { result } = renderHook(() => useConversationExport(), { wrapper: wrapperFor(api) });
    await act(async () => {
      await result.current.runExport({
        socialAccountId: "acct",
        accountLabel: "Support",
        chats: [chat("conv-1", "Ahmed"), chat("conv-2", "Sara")],
        format: "md",
        includeMedia: true,
        exportedAt: new Date("2026-08-25T10:00:00.000Z"),
      });
    });

    expect(downloads).toHaveLength(1);
    const entries = unzipSync(new Uint8Array(await downloads[0].blob.arrayBuffer()));
    const missing = Object.keys(entries).find((name) => name.endsWith("_missing.txt"));
    expect(missing).toBeDefined();
    expect(strFromU8(entries[missing as string])).toContain("row-1");
    vi.unstubAllGlobals();
  });

  it("reports per-chat progress rather than a single total", async () => {
    const api = makeApi({}, downloads);
    const { result } = renderHook(() => useConversationExport(), { wrapper: wrapperFor(api) });

    await act(async () => {
      await result.current.runExport({
        socialAccountId: "acct",
        accountLabel: "Support",
        chats: [chat("conv-1", "Ahmed"), chat("conv-2", "Sara")],
        format: "md",
        includeMedia: false,
        exportedAt: new Date("2026-08-25T10:00:00.000Z"),
      });
    });

    expect(result.current.progress?.totalChats).toBe(2);
    expect(result.current.progress?.chats.map((c) => c.participantName)).toEqual(["Ahmed", "Sara"]);
    expect(result.current.progress?.chats.every((c) => c.state === "done")).toBe(true);
  });
});
