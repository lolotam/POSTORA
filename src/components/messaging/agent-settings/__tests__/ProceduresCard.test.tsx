import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProceduresCard } from "../ProceduresCard";

const setup = (procedures = {}) => {
  const updateBehavior = vi.fn();
  render(<ProceduresCard form={{} as never} update={vi.fn()} behavior={{ procedures }} updateBehavior={updateBehavior} />);
  return updateBehavior;
};

describe("ProceduresCard", () => {
  it("turning a flow on merges only that flow into procedures", () => {
    const updateBehavior = setup({ booking: { enabled: true, prompts: {}, closing: "" } });
    fireEvent.click(screen.getByRole("switch", { name: /lead capture/i }));
    expect(updateBehavior).toHaveBeenCalledWith("procedures", {
      booking: { enabled: true, prompts: {}, closing: "" },
      lead_capture: { enabled: true, prompts: {}, closing: "" },
    });
  });

  it("enabling the product finder seeds the two question slots the business must fill", () => {
    const updateBehavior = setup();
    fireEvent.click(screen.getByRole("switch", { name: /product finder/i }));
    expect(updateBehavior).toHaveBeenCalledWith("procedures", {
      product_finder: { enabled: true, prompts: {}, closing: "", questions: ["", ""] },
    });
  });

  it("editing a field prompt writes it under that field's name", () => {
    const updateBehavior = setup({ order_status: { enabled: true, prompts: {}, closing: "" } });
    fireEvent.change(screen.getByLabelText(/order_number/i), { target: { value: "Your order number please" } });
    expect(updateBehavior).toHaveBeenLastCalledWith("procedures", {
      order_status: { enabled: true, prompts: { order_number: "Your order number please" }, closing: "" },
    });
  });
});
