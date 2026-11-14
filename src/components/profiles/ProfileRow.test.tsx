import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { AccountReconnectButton } from "./ProfileRow";

describe("existing-account analytics repair", () => {
  it.each([
    ["instagram", false, false, true],
    ["facebook", false, false, false],
    ["facebook", true, false, true],
    ["facebook", false, true, true],
  ] as const)("offers %s reconnect with expired=%s and needsReauth=%s", (platform, expired, needsReauth, offered) => {
    const profileId = crypto.randomUUID();
    const account = { id: crypto.randomUUID(), platform };
    const onReconnect = vi.fn();
    const parentClick = vi.fn();
    const { queryByRole } = render(<div onClick={parentClick}><AccountReconnectButton profileId={profileId} account={account}
      expired={expired} needsReauth={needsReauth} isReconnecting={false} onReconnect={onReconnect} /></div>);
    const button = queryByRole("button", { name: "Reconnect" });
    expect(Boolean(button)).toBe(offered);
    if (button) {
      fireEvent.click(button);
      expect(onReconnect).toHaveBeenCalledWith(profileId, platform, account.id);
      expect(parentClick).not.toHaveBeenCalled();
    }
  });

  it("does not start a second reconnect while the existing one is running", () => {
    const onReconnect = vi.fn();
    const { getByRole } = render(<AccountReconnectButton profileId={crypto.randomUUID()}
      account={{ id: crypto.randomUUID(), platform: "instagram" }} expired={false} needsReauth={false}
      isReconnecting onReconnect={onReconnect} />);
    fireEvent.click(getByRole("button", { name: "Reconnect" }));
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
