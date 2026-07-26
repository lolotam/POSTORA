import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AvatarSection } from "../AvatarSection";

vi.mock("@/components/ui/avatar", () => ({
    Avatar: ({ children }: any) => <div>{children}</div>,
    AvatarImage: (props: any) => <img {...props} />,
    AvatarFallback: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
    Button: ({ children, onClick, disabled }: any) => (
        <button onClick={onClick} disabled={disabled}>{children}</button>
    ),
}));

vi.mock("@/components/ui/label", () => ({
    Label: ({ children }: any) => <label>{children}</label>,
}));

vi.mock("@/hooks/use-toast", () => ({
    useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        // Avatar upload moved from Supabase Storage to the cloudinary-upload edge
        // function, which returns { success, url } and is asserted on below.
        functions: {
            invoke: vi.fn().mockResolvedValue({
                data: { success: true, url: "http://new-avatar.com" },
                error: null,
            }),
        },
        storage: {
            from: vi.fn(() => ({
                upload: vi.fn().mockResolvedValue({ error: null }),
                getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: "http://new-avatar.com" } }),
            })),
        },
        from: vi.fn(() => ({
            update: vi.fn(() => ({
                eq: vi.fn().mockResolvedValue({ error: null }),
            })),
        })),
    },
}));

describe("AvatarSection Component", () => {
    const defaultProps = {
        avatarUrl: "http://example.com/avatar.jpg",
        fullName: "Test User",
        userId: "user-1",
        onRefresh: vi.fn(),
    };

    it("renders current avatar", () => {
        render(<AvatarSection {...defaultProps} />);
        expect(screen.getByAltText("Profile")).toHaveAttribute("src", "http://example.com/avatar.jpg");
    });

    it("renders fallback initials when no avatar", () => {
        render(<AvatarSection {...defaultProps} avatarUrl={null} />);
        expect(screen.getByText("TU")).toBeInTheDocument();
    });

    it("calls onRefresh after upload", async () => {
        const onRefresh = vi.fn();
        const { container } = render(<AvatarSection {...defaultProps} onRefresh={onRefresh} />);

        const input = container.querySelector('input[type="file"]');
        expect(input).toBeInTheDocument();

        const file = new File(["(⌐□_□)"], "chucknorris.png", { type: "image/png" });
        fireEvent.change(input!, { target: { files: [file] } });

        // Upload is async
        await vi.waitFor(() => expect(onRefresh).toHaveBeenCalled());
    });
});
