// Turning an uploaded file into indexable chunks.
//
// Extracted from index.ts so ai-knowledge-excel-worker can parse the same source
// types the inline path does. The worker previously understood CSV and Excel
// only, which is why a large markdown or PDF had no queue to fall back to and
// died against the 60s edge ceiling instead.
//
// Sits beside chunking.ts and graph.ts, the layout the worker already imports
// from.

import * as XLSX from "npm:xlsx@0.18.5";
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";
import {
  chunkProfileText,
  chunkRows,
  rowToText,
  type KnowledgeChunk,
} from "./chunking.ts";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// Images become text via a vision model: menus, price lists, and product
// photos get described/transcribed so they are searchable like any document.
// Image OCR runs on Gemini (OpenAI billing is exhausted). Uses the same
// OpenAI-compatible chat endpoint as ai-agent-reply, with a multimodal model.
const VISION_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const VISION_MODEL = "gemini-2.5-flash";

export async function extractImageText(bytes: Uint8Array, fileName: string): Promise<string> {
  const key = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!key)
    throw new Error("GOOGLE_AI_STUDIO_KEY is not configured; knowledge cannot be indexed.");
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  const mime = IMAGE_MIME_BY_EXTENSION[extension];
  if (!mime) throw new Error(`Unsupported image type: .${extension}`);
  const response = await fetch(VISION_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract ALL business-relevant information from this image (product names, prices, descriptions, policies, contact details, menu items). Transcribe visible text verbatim. Output plain text only.",
            },
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${toBase64(bytes)}` },
            },
          ],
        },
      ],
      max_tokens: 1500,
    }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data?.error?.message || "Image extraction failed");
  const text = (data.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("No text could be extracted from the image");
  return text;
}

export async function parseSourceFile(
  sourceType: string,
  fileName: string,
  file: Blob,
): Promise<KnowledgeChunk[]> {
  if (sourceType === "csv" || sourceType === "excel") {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows: Array<{ text: string; sheet: string; row: number }> = [];
    for (const sheet of workbook.SheetNames) {
      XLSX.utils
        .sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheet], {
          defval: "",
        })
        .forEach((row, index) =>
          rows.push({ text: rowToText(row), sheet, row: index + 2 }),
        );
    }
    return chunkRows(rows);
  }
  if (sourceType === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    if (!text?.trim())
      throw new Error("No extractable text found in the PDF (scanned PDFs are not supported yet)");
    return chunkProfileText(text);
  }
  if (sourceType === "doc") {
    const text = (await file.text()).trim();
    if (!text) throw new Error("The document is empty");
    return chunkProfileText(text);
  }
  if (sourceType === "image") {
    const text = await extractImageText(
      new Uint8Array(await file.arrayBuffer()),
      fileName,
    );
    return chunkProfileText(text);
  }
  throw new Error(`Source type not supported: ${sourceType}`);
}
