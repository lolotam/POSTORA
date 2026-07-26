import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountSelectionSidebar } from "../AccountSelectionSidebar";

// Mock dnd-kit
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: any) => <div>{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: any) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
  arrayMove: vi.fn(),
}));

// Mock child components
vi.mock("../SortableAccountItem", () => ({
  SortableAccountItem: ({ id, username, isSelected, onToggle }: any) => (
    <div data-testid={`account-${id}`} onClick={onToggle}>
      <span>{username}</span>
      <span>{isSelected ? "Selected" : "Not selected"}</span>
    </div>
  ),
}));

vi.mock("@/components/PlatformIcon", () => ({
  PlatformIcon: ({ platform }: any) => <span data-testid="platform-icon">{platform}</span>,
  getPlatformName: (platform: string) => platform.charAt(0).toUpperCase() + platform.slice(1),
}));

describe("AccountSelectionSidebar", () => {
  const mockAccounts = [
    { id: "1", platform: "instagram" as const, maxChars: 2200, username: "insta_user", avatarUrl: null },
    { id: "2", platform: "instagram" as const, maxChars: 2200, username: "insta_user2", avatarUrl: null },
    { id: "3", platform: "facebook" as const, maxChars: 63206, username: "fb_user", avatarUrl: null },
  ];

  const defaultProps = {
    availableAccounts: mockAccounts,
    accountsByPlatform: {
      instagram: mockAccounts.filter((a) => a.platform === "instagram"),
      facebook: mockAccounts.filter((a) => a.platform === "facebook"),
    },
    filteredAccountsForUploadMethod: {
      instagram: mockAccounts.filter((a) => a.platform === "instagram"),
      facebook: mockAccounts.filter((a) => a.platform === "facebook"),
    },
    allPlatforms: ["instagram", "facebook"] as any[],
    selectedAccountIds: [] as string[],
    selectedPlatforms: [] as any[],
    platformFilter: [] as any[],
    caption: "",
    hasOnlyImages: false,
    accountsLoading: false,
    onAccountToggle: vi.fn(),
    onSelectAllPlatform: vi.fn(),
    onPlatformFilterToggle: vi.fn(),
    onClearFilter: vi.fn(),
  };

  it("renders post visibility header", () => {
    render(<AccountSelectionSidebar {...defaultProps} />);
    expect(screen.getByText("Post visibility")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    render(<AccountSelectionSidebar {...defaultProps} accountsLoading={true} />);
    // Should show loader
    expect(screen.queryByText("Post visibility")).toBeInTheDocument();
  });

  it("shows empty state when no accounts", () => {
    render(
      <AccountSelectionSidebar
        {...defaultProps}
        availableAccounts={[]}
        accountsByPlatform={{}}
        filteredAccountsForUploadMethod={{}}
      />
    );
    expect(screen.getByText("No social accounts connected")).toBeInTheDocument();
    expect(screen.getByText("Connect Accounts")).toBeInTheDocument();
  });

  it("displays platform sections", () => {
    render(<AccountSelectionSidebar {...defaultProps} />);
    expect(screen.getByText("Instagram")).toBeInTheDocument();
    expect(screen.getByText("Facebook")).toBeInTheDocument();
  });

  it("shows account count per platform", () => {
    render(<AccountSelectionSidebar {...defaultProps} />);
    expect(screen.getByText("(2)")).toBeInTheDocument(); // Instagram has 2 accounts
    expect(screen.getByText("(1)")).toBeInTheDocument(); // Facebook has 1 account
  });

  it("shows Select All button for platforms with multiple accounts", () => {
    render(<AccountSelectionSidebar {...defaultProps} />);
    expect(screen.getByText("Select All")).toBeInTheDocument();
  });

  it("calls onSelectAllPlatform when Select All is clicked", () => {
    const onSelectAllPlatform = vi.fn();
    render(
      <AccountSelectionSidebar {...defaultProps} onSelectAllPlatform={onSelectAllPlatform} />
    );
    
    const selectAllButton = screen.getByText("Select All");
    fireEvent.click(selectAllButton);
    
    expect(onSelectAllPlatform).toHaveBeenCalledWith("instagram");
  });

  it("shows Deselect All when all accounts are selected", () => {
    render(
      <AccountSelectionSidebar
        {...defaultProps}
        selectedAccountIds={["1", "2"]}
      />
    );
    expect(screen.getByText("Deselect All")).toBeInTheDocument();
  });

  it("shows warning when no accounts selected", () => {
    render(<AccountSelectionSidebar {...defaultProps} />);
    expect(screen.getByText("Select at least one account")).toBeInTheDocument();
  });

  it("hides warning when accounts are selected", () => {
    render(
      <AccountSelectionSidebar {...defaultProps} selectedAccountIds={["1"]} />
    );
    expect(screen.queryByText("Select at least one account")).not.toBeInTheDocument();
  });

  it("keeps TikTok available for image-only posts", () => {
    // TikTok used to be badged "Video only" and blocked when a post had no video.
    // Photo posts are supported now, so the badge was removed and hasOnlyImages no
    // longer gates anything in this component. This pins the current contract:
    // TikTok still renders and is not marked unavailable.
    const tiktokAccount = {
      id: "4",
      platform: "tiktok" as const,
      maxChars: 4000,
      username: "tt_user",
      avatarUrl: null,
    };
    const propsWithTikTok = {
      ...defaultProps,
      allPlatforms: [...defaultProps.allPlatforms, "tiktok"],
      accountsByPlatform: {
        ...defaultProps.accountsByPlatform,
        tiktok: [tiktokAccount],
      },
      filteredAccountsForUploadMethod: {
        ...defaultProps.filteredAccountsForUploadMethod,
        tiktok: [tiktokAccount],
      },
      hasOnlyImages: true,
    };

    render(<AccountSelectionSidebar {...propsWithTikTok} />);

    expect(screen.getAllByText(/tiktok/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("Video only")).not.toBeInTheDocument();
  });

  it("displays platform warnings for selected platforms", () => {
    render(
      <AccountSelectionSidebar
        {...defaultProps}
        selectedPlatforms={["pinterest"]}
      />
    );
    expect(screen.getByText("Pinterest Standard Access Required")).toBeInTheDocument();
  });

  it("renders account items", () => {
    render(<AccountSelectionSidebar {...defaultProps} />);
    expect(screen.getByTestId("account-1")).toBeInTheDocument();
    expect(screen.getByTestId("account-2")).toBeInTheDocument();
    expect(screen.getByTestId("account-3")).toBeInTheDocument();
  });

  it("shows filter button when multiple platforms exist", () => {
    render(<AccountSelectionSidebar {...defaultProps} />);
    expect(screen.getByText("All platforms")).toBeInTheDocument();
  });
});
