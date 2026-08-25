import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppInboxApi } from "../application/ports";
import { useWhatsAppInboxApi } from "../application/ports";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";

const fakeApi: WhatsAppInboxApi = {
  getMessagesPage: vi.fn(),
  getMedia: vi.fn(),
  sendMedia: vi.fn(),
  sendInteractive: vi.fn(),
};

function Probe(): JSX.Element {
  const api = useWhatsAppInboxApi();
  return <div>{api === fakeApi ? "wired" : "wrong"}</div>;
}

describe("WhatsAppInboxApiProvider", () => {
  it("supplies the port instance to consumers", () => {
    render(
      <WhatsAppInboxApiProvider api={fakeApi}>
        <Probe />
      </WhatsAppInboxApiProvider>,
    );
    expect(screen.getByText("wired")).toBeInTheDocument();
  });

  it("throws when the composition root did not wrap the tree", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/WhatsAppInboxApiProvider/);
    spy.mockRestore();
  });
});
