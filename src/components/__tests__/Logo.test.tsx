import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Logo } from "../Logo";
import { useAppSettings } from "@/hooks/useAppSettings";

vi.mock("@/hooks/useAppSettings", () => ({
  useAppSettings: vi.fn(),
}));

function mockSettings(appLogo: string | null) {
  vi.mocked(useAppSettings).mockReturnValue({
    data: { appName: "Postora", appLogo, appFavicon: null },
    isLoading: false,
  } as never);
}

describe("Logo header image", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the custom logo when the URL loads", () => {
    mockSettings("https://cdn.example.com/logo.png");
    render(<Logo />);
    expect(screen.getByAltText("Postora logo")).toHaveAttribute(
      "src",
      "https://cdn.example.com/logo.png"
    );
  });

  it("falls back to the built-in mark when the custom logo fails to load", () => {
    mockSettings("https://cdn.example.com/dead-logo.png");
    const { container } = render(<Logo />);
    fireEvent.error(screen.getByAltText("Postora logo"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders the built-in mark for a blank logo URL instead of a broken image", () => {
    mockSettings("   ");
    const { container } = render(<Logo />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
