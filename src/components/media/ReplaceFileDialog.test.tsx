import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReplaceFileDialog } from "./ReplaceFileDialog";

const invoke = vi.fn();
const storageFrom = vi.fn();
const tableFrom = vi.fn();
const toast = vi.fn();
const logOperation = vi.fn(async () => "op-1");
const completeOperation = vi.fn(async () => undefined);
const failOperation = vi.fn(async () => undefined);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
      const template = typeof fallback === "string" ? fallback : key;
      const values = typeof fallback === "object" && fallback ? fallback : options;
      if (!values) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(values[name] ?? ""));
    },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

vi.mock("@/hooks/useMediaOperationsHistory", () => ({
  useLogMediaOperation: () => ({ logOperation, completeOperation, failOperation }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
    storage: { from: (...args: unknown[]) => storageFrom(...args) },
    from: (...args: unknown[]) => tableFrom(...args),
  },
}));

class MockFileReader {
  result: string | null = null;
  error: Error | null = null;
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  readAsDataURL() {
    this.result = "data:image/png;base64,aGk=";
    this.onload?.();
  }
}

const imageFile = {
  id: "file-1",
  publicUrl: "https://cdn.example/old.png",
  file_type: "image",
  file_path: "https://cdn.example/old.png",
  mime_type: "image/png",
  metadata: { kind: "image", original_filename: "holiday.png" },
};

function renderDialog() {
  return render(
    <ReplaceFileDialog open onClose={vi.fn()} file={imageFile} userId="user-1" onReplaced={vi.fn()} />,
  );
}

function pickFile(name: string, type: string) {
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("file input missing");
  const file = new File(["hello"], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

async function pickAcceptedFile(name: string, type: string) {
  pickFile(name, type);
  await screen.findByText("New file selected");
}

describe("ReplaceFileDialog", () => {
  beforeEach(() => {
    invoke.mockReset();
    storageFrom.mockReset();
    tableFrom.mockReset();
    toast.mockReset();
    logOperation.mockClear();
    completeOperation.mockClear();
    failOperation.mockClear();
    vi.stubGlobal("FileReader", MockFileReader);
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:preview" });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
    }
  });

  it("sends one JSON upload that names the same library file and does not delete or rewrite the row itself", async () => {
    invoke.mockResolvedValue({ data: { success: true, url: "https://cdn.example/new.png", mediaFileId: "file-1" }, error: null });
    renderDialog();
    await pickAcceptedFile("next.png", "image/png");

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("cloudinary-upload", {
      body: {
        fileData: "data:image/png;base64,aGk=",
        fileName: "next.png",
        fileType: "image",
        replaceMediaFileId: "file-1",
      },
    });
    expect(storageFrom).not.toHaveBeenCalled();
    expect(tableFrom).not.toHaveBeenCalled();
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("cloudinary-delete");
  });

  it("shows the server's error message when the replace is refused", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: {
        message: "Edge Function returned a non-2xx status code",
        context: new Response(JSON.stringify({ error: "The file changed while replacing; try again" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      },
    });
    renderDialog();
    await pickAcceptedFile("next.png", "image/png");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: "The file changed while replacing; try again",
      variant: "destructive",
    })));
    expect(storageFrom).not.toHaveBeenCalled();
    expect(tableFrom).not.toHaveBeenCalled();
  });

  it("rejects a file of a different kind before calling the server", async () => {
    renderDialog();
    pickFile("notes.pdf", "application/pdf");

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: "The new file must be the same kind as the old one",
    })));
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
