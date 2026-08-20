import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResolvedModelCards } from "../ResolvedModelCards";

const tier = (model_id: string, name: string) => ({ provider_code: "higgsfield", model_id, name });

describe("ResolvedModelCards", () => {
  it("labels each configured tier", () => {
    render(
      <ResolvedModelCards
        tiers={[tier("gpt_image_2", "GPT Image 2"), tier("nano_banana_2", "Nano Banana 2"), tier("soul_2", "Soul 2.0")]}
      />,
    );
    expect(screen.getByText("GPT Image 2")).toBeInTheDocument();
    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.getByText("Fallback")).toBeInTheDocument();
    expect(screen.getByText("Fallback 2")).toBeInTheDocument();
  });

  it("renders only the tiers that are configured", () => {
    render(<ResolvedModelCards tiers={[tier("gpt_image_2", "GPT Image 2")]} />);
    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.queryByText("Fallback")).not.toBeInTheDocument();
  });

  it("says so when nothing is configured", () => {
    render(<ResolvedModelCards tiers={[]} />);
    expect(screen.getByText(/no image model has been configured/i)).toBeInTheDocument();
  });

  // The server only walks three tiers; a longer list must not imply otherwise.
  it("never renders more than three tiers", () => {
    render(
      <ResolvedModelCards
        tiers={[
          tier("a", "Model A"),
          tier("b", "Model B"),
          tier("c", "Model C"),
          tier("d", "Model D"),
        ]}
      />,
    );
    expect(screen.queryByText("Model D")).not.toBeInTheDocument();
  });
});
