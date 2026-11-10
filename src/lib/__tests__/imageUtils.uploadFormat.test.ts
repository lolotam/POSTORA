import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressImage } from "../imageUtils";

// Image decoding and canvas encoding are browser boundaries. Keep the real
// File/Blob path so the upload filename, MIME and encoded bytes stay together.
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);

describe("compressed posting images", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", class {
      width = 1086;
      height = 1448;
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:source-image"; }
      static revokeObjectURL() {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      callback(new Blob([jpegBytes], { type }));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["03.png", "03.jpg"],
    ["photo.PNG", "photo.jpg"],
    ["photo.webp", "photo.jpg"],
    ["photo.jpg", "photo.jpg"],
    ["photo", "photo.jpg"],
  ])("uploads JPEG output from %s with matching filename %s", async (name, expectedName) => {
    const original = new File([new Uint8Array(1_817_960)], name, { type: "image/png" });
    const result = await compressImage(original, 0.85, 2048, 2048);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(result);
    });

    expect(result.name).toBe(expectedName);
    expect(result.type).toBe("image/jpeg");
    expect(dataUrl).toBe("data:image/jpeg;base64,/9j/4P/Z");
    expect(original.name).toBe(name);
    expect(original.size).toBe(1_817_960);
  });
});
