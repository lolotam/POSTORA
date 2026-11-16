import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { PostSavedActions } from "../PostSavedActions";

describe("saved-post actions", () => {
  it("offers a fresh post and history without claiming background publishing succeeded", async () => {
    const createNew = vi.fn();
    render(<MemoryRouter><PostSavedActions postId="post-123" status="submitted" onCreateNewPost={createNew} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "View History" })).toHaveAttribute("href", "/history");
    expect(screen.queryByText(/published successfully/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create new post" }));
    expect(createNew).toHaveBeenCalledOnce();
  });
});
