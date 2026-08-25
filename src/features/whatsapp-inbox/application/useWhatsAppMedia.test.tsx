import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppInboxApi, WhatsAppResolvedMedia } from "./ports";
import { WhatsAppInboxApiProvider } from "../ui/WhatsAppInboxApiProvider";
import {
  WA_MEDIA_BATCH_SIZE,
  WA_MEDIA_STALE_TIME_MS,
  WhatsAppMediaScope,
  useWhatsAppMedia,
} from "./useWhatsAppMedia";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function resolved(rowId: string, overrides: Partial<WhatsAppResolvedMedia> = {}): WhatsAppResolvedMedia {
  return {
    message_row_id: rowId,
    kind: "image",
    url: `https://signed.example/${rowId}`,
    expires_in: 3600,
    ...overrides,
  };
}

function Probe({ ids }: { ids: string[] }): JSX.Element {
  const { requestMedia, mediaByRowId } = useWhatsAppMedia();
  return (
    <div>
      <button type="button" onClick={() => ids.forEach((id) => requestMedia(id))}>
        request
      </button>
      <div data-testid="resolved-count">{mediaByRowId.size}</div>
    </div>
  );
}

function renderMedia(
  ui: ReactElement,
  api: WhatsAppInboxApi,
  queryClient = createQueryClient(),
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <WhatsAppInboxApiProvider api={api}>
        <WhatsAppMediaScope socialAccountId="acct-1">{children}</WhatsAppMediaScope>
      </WhatsAppInboxApiProvider>
    </QueryClientProvider>
  );
  return { ...render(ui, { wrapper }), queryClient };
}

describe("useWhatsAppMedia", () => {
  let getMedia: ReturnType<typeof vi.fn>;
  let api: WhatsAppInboxApi;

  beforeEach(() => {
    getMedia = vi.fn(async ({ message_row_ids }: { message_row_ids: string[] }) => ({
      media: message_row_ids.map((id) => resolved(id)),
    }));
    api = {
      getMessagesPage: vi.fn(),
      getMedia,
      sendMedia: vi.fn(),
      sendInteractive: vi.fn(),
      getConversationState: vi.fn(),
      setMessageFlag: vi.fn(),
      revokeMessage: vi.fn(),
      sendVoice: vi.fn(),
    };
  });

  // Regression, 2026-08-25: a 707-message thread used to recover every attachment on
  // mount, flooding whatsapp_get_media. Resolution must wait for an explicit request.
  it("does not fetch media on mount", () => {
    renderMedia(<Probe ids={["a", "b"]} />, api);
    expect(getMedia).not.toHaveBeenCalled();
  });

  it("batches collected ids at most 10 per call", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `row-${i}`);
    renderMedia(<Probe ids={ids} />, api);
    fireEvent.click(screen.getByRole("button", { name: "request" }));

    await waitFor(() => expect(getMedia).toHaveBeenCalledTimes(2));
    const batches = getMedia.mock.calls.map((call) => call[0].message_row_ids as string[]);
    expect(batches.every((batch) => batch.length <= WA_MEDIA_BATCH_SIZE)).toBe(true);
    expect(batches[0]).toHaveLength(10);
    expect(batches[1]).toHaveLength(2);
    expect(new Set(batches.flat()).size).toBe(12);
  });

  it("keys the query by account and the sorted row ids with a staleTime under the signed-url TTL", async () => {
    const queryClient = createQueryClient();
    renderMedia(<Probe ids={["b", "a"]} />, api, queryClient);
    fireEvent.click(screen.getByRole("button", { name: "request" }));

    await waitFor(() => expect(getMedia).toHaveBeenCalled());
    const query = queryClient.getQueryCache().find({
      queryKey: ["wa-media", "acct-1", ["a", "b"]],
    });
    expect(query).toBeTruthy();
    expect(query?.options.staleTime).toBe(WA_MEDIA_STALE_TIME_MS);
    expect(WA_MEDIA_STALE_TIME_MS).toBeLessThan(3600 * 1000);
  });

  it("maps a missing row onto MEDIA_UNAVAILABLE rather than leaving the bubble pending", async () => {
    getMedia.mockResolvedValueOnce({ media: [] });
    renderMedia(<Probe ids={["gone"]} />, api);
    fireEvent.click(screen.getByRole("button", { name: "request" }));
    await waitFor(() => expect(screen.getByTestId("resolved-count")).toHaveTextContent("1"));
  });
});
