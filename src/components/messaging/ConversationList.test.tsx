import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/hooks/useMessaging";
import { ConversationList } from "./ConversationList";

function conv(id: string, name: string): Conversation {
  return {
    id,
    participant_name: name,
    participant_id: id.replace(/^wa_\d+_/, ""),
    participant_avatar: null,
    last_message: "hi",
    last_message_time: "2026-09-06T10:00:00.000Z",
    last_message_from: name,
    unread_count: 0,
    updated_time: "2026-09-06T10:00:00.000Z",
  };
}

describe("ConversationList controlled search", () => {
  it("reports typing to the owner and does not filter locally", () => {
    const onSearchChange = vi.fn();
    render(
      <ConversationList
        conversations={[conv("wa_1_96555", "Ali"), conv("wa_1_96599", "Sara")]}
        selectedId={null}
        onSelect={vi.fn()}
        isLoading={false}
        search="9659"
        onSearchChange={onSearchChange}
      />,
    );
    // The server already applied "9659"; the client must not hide Ali on a name-only match.
    expect(screen.getByText("Ali")).toBeInTheDocument();
    expect(screen.getByText("Sara")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search conversations..."), { target: { value: "sa" } });
    expect(onSearchChange).toHaveBeenCalledWith("sa");
  });

  it("still filters locally when uncontrolled", () => {
    render(
      <ConversationList
        conversations={[conv("wa_1_96555", "Ali"), conv("wa_1_96599", "Sara")]}
        selectedId={null}
        onSelect={vi.fn()}
        isLoading={false}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Search conversations..."), { target: { value: "sa" } });
    expect(screen.queryByText("Ali")).not.toBeInTheDocument();
    expect(screen.getByText("Sara")).toBeInTheDocument();
  });
});
