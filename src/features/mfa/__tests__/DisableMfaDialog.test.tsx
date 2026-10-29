import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@/i18n";
import { DisableMfaDialog } from "../ui/DisableMfaDialog";

function renderDialog(props: Partial<Parameters<typeof DisableMfaDialog>[0]> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<DisableMfaDialog open submitting={false} codeError={null} onSubmit={onSubmit} onCancel={onCancel} {...props} />);
  return { onSubmit, onCancel, input: screen.getByPlaceholderText("000000") as HTMLInputElement };
}

describe("DisableMfaDialog", () => {
  it("keeps only digits and submits once six are entered", () => {
    const { onSubmit, input } = renderDialog();
    const submit = screen.getByRole("button", { name: /turn off 2fa|إيقاف/i });

    fireEvent.change(input, { target: { value: "12a3" } });
    expect(input.value).toBe("123");
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "123456" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith("123456");
  });

  it("shows the code error as an alert", () => {
    renderDialog({ codeError: "Invalid code" });
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid code");
  });

  it("disables Cancel and Submit while submitting, and ignores a close request", () => {
    const { onCancel } = renderDialog({ submitting: true });
    expect(screen.getByRole("button", { name: /cancel|إلغاء/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /turning off|جارٍ|جاري/i })).toBeDisabled();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
