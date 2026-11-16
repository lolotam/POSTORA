import { createRef, useState } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { UploadedFile } from "@/hooks/usePostForm";
import { MediaUploadArea } from "../MediaUploadArea";

vi.mock("@/hooks/useFeatureFlags", () => ({ useFeatureFlags: () => ({ flags: {}, isLoading: false }) }));
vi.mock("../MediaLightbox", () => ({ MediaLightbox: () => null }));
const translations = createInstance();
await translations.init({ lng: "en", resources: { en: { postmedia: {} } }, defaultNS: "postmedia" });

function Gallery({ pending = false }: { pending?: boolean }) {
  const [files, setFiles] = useState<UploadedFile[]>(["first", "second", "third"].map((id, index) => ({
    id, file: new File([id], `${id}.png`, { type: "image/png" }),
    previewUrl: `https://images.example/${id}.png`, fileType: "image", altText: id,
    uploadProgress: pending && index === 2 ? 20 : 100, uploaded: !pending || index !== 2,
  })));
  return <>
    <button type="button" onClick={() => setFiles((current) => current.map((file) => file.id === "third" ? {
      ...file, uploaded: true, uploadProgress: 100, storagePath: "persisted-third", altText: "third-complete",
    } : file))}>Complete third</button>
    <button type="button" onClick={() => setFiles((current) => current.filter((file) => file.id !== "first"))}>Remove first</button>
    <MediaUploadArea
      uploadMethod="local" files={files} isDragging={false} isUploading={pending} selectedPlatforms={[]}
      urlMediaType="images" setUrlMediaType={vi.fn()} imageUrls="" setImageUrls={vi.fn()}
      videoUrl="" setVideoUrl={vi.fn()} fileInputRef={createRef<HTMLInputElement>()}
      onFileSelect={vi.fn()} onDragOver={vi.fn()} onDragLeave={vi.fn()} onDrop={vi.fn()}
      onRemoveFile={vi.fn()} onOpenCropper={vi.fn()} onOpenCompressor={vi.fn()} onImageCropRequest={vi.fn()}
      onReorderFiles={setFiles}
    />
  </>;
}
afterEach(() => vi.restoreAllMocks());

describe("media publishing order", () => {
  it("numbers selected media before uploads finish and only enables completed handles", () => {
    render(<I18nextProvider i18n={translations}><Gallery pending /></I18nextProvider>);
    expect(screen.getByLabelText("Publishing position 1")).toHaveTextContent("1");
    expect(screen.getByLabelText("Publishing position 3")).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: "Move media 1" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Move media 3" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("img").map(img => img.getAttribute("alt"))).toEqual(["first", "second", "third"]);
  });

  it.each([
    ["ArrowRight", ["second", "first", "third"]],
    ["ArrowDown", ["second", "third", "first"]],
  ])("keyboard %s reorders within or across rows and renumbers the media", async (key, expectedOrder) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const handle = this.querySelector('button[aria-label^="Move media"]') ?? this;
      const position = Number(handle.getAttribute("aria-label")?.match(/Move media (\d+)/)?.[1] ?? 1) - 1;
      const x = (position % 2) * 120;
      const y = Math.floor(position / 2) * 120;
      return { x, y, top: y, left: x, right: x + 100, bottom: y + 100, width: 100, height: 100, toJSON: () => ({}) };
    });
    render(<I18nextProvider i18n={translations}><Gallery /></I18nextProvider>);
    screen.getByRole("button", { name: "Move media 1" }).focus();
    await userEvent.keyboard("[Space]");
    await userEvent.keyboard(`[${key}]`);
    await userEvent.keyboard("[Space]");
    await waitFor(() => expect(screen.getAllByRole("img").map(img => img.getAttribute("alt"))).toEqual(expectedOrder));
    const firstCard = screen.getByAltText("second").parentElement!;
    expect(within(firstCard).getByLabelText("Publishing position 1")).toHaveTextContent("1");
    expect(within(firstCard).getByRole("button", { name: "Move media 1" })).toBeEnabled();
  });

  it("applies a drop to current state when an upload completes during the drag", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const handle = this.querySelector('button[aria-label^="Move media"]') ?? this;
      const position = Number(handle.getAttribute("aria-label")?.match(/Move media (\d+)/)?.[1] ?? 1) - 1;
      return { x: position * 120, y: 0, top: 0, left: position * 120, right: position * 120 + 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) };
    });
    render(<I18nextProvider i18n={translations}><Gallery pending /></I18nextProvider>);
    screen.getByRole("button", { name: "Move media 1" }).focus();
    await userEvent.keyboard("[Space]");
    await userEvent.click(screen.getByRole("button", { name: "Complete third" }));
    await userEvent.keyboard("[ArrowRight][Space]");
    await waitFor(() => expect(screen.getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["second", "first", "third-complete"]));
    expect(screen.getByAltText("third-complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move media 3" })).toBeEnabled();
    expect(await screen.findByText("Moved to position 2 of 3.")).toBeInTheDocument();
  });

  it("reorders with a touch pointer across the grid", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const handle = this.querySelector('button[aria-label^="Move media"]') ?? this;
      const position = Number(handle.getAttribute("aria-label")?.match(/Move media (\d+)/)?.[1] ?? 1) - 1;
      return { x: position * 120, y: 0, top: 0, left: position * 120, right: position * 120 + 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) };
    });
    render(<I18nextProvider i18n={translations}><Gallery /></I18nextProvider>);
    const handle = screen.getByRole("button", { name: "Move media 1" });
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 50, clientY: 50, button: 0, buttons: 1 });
    fireEvent.pointerMove(document, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 170, clientY: 50, button: 0, buttons: 1 });
    fireEvent.pointerMove(document, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 170, clientY: 50, button: 0, buttons: 1 });
    fireEvent.pointerUp(document, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 170, clientY: 50, button: 0, buttons: 0 });
    await waitFor(() => expect(screen.getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["second", "first", "third"]));
  });

  it("moves media left in an RTL grid while preserving the moved handle focus", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const handle = this.querySelector('button[aria-label^="Move media"]') ?? this;
      const position = Number(handle.getAttribute("aria-label")?.match(/Move media (\d+)/)?.[1] ?? 1) - 1;
      const x = (2 - position) * 120;
      return { x, y: 0, top: 0, left: x, right: x + 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) };
    });
    render(<I18nextProvider i18n={translations}><div dir="rtl"><Gallery /></div></I18nextProvider>);
    const handle = screen.getByRole("button", { name: "Move media 1" });
    handle.focus();
    await userEvent.keyboard("[Space][ArrowLeft][Space]");
    await waitFor(() => expect(screen.getAllByRole("img").map(img => img.getAttribute("alt"))).toEqual(["second", "first", "third"]));
    expect(document.activeElement).toBe(handle);
    expect(handle).toHaveAccessibleName("Move media 2");
  });

  it("cancels with Escape without changing order and retains handle focus", async () => {
    render(<I18nextProvider i18n={translations}><div dir="rtl"><Gallery /></div></I18nextProvider>);
    const handle = screen.getByRole("button", { name: "Move media 1" });
    handle.focus();
    await userEvent.keyboard("[Space][ArrowLeft][Escape]");
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["first", "second", "third"]);
    expect(document.activeElement).toBe(handle);
    expect(handle).toHaveClass("touch-none", "h-11", "w-11");
    expect(handle.parentElement).not.toHaveClass("touch-none");
  });
});
