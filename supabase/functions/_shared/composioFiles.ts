// Moving a file into Composio for a tool's file input (spec §1, live spike
// 2026-09-03): ask for a presigned slot, PUT the bytes to it, and hand the
// returned key to the tool as `s3key`. The bytes are read from a caller-owned
// buffer so this module never touches Supabase storage or signed URLs itself.
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.224.0/encoding/hex.ts";
import { ComposioError, type ComposioClient } from "./composioClient.ts";

/** The exact shape Composio tools accept for a `FileUploadable` input. */
export interface ComposioUploadedFile {
  name: string;
  mimetype: string;
  s3key: string;
}

export interface ComposioFileUploadInput {
  toolkit: string;
  tool: string;
  filename: string;
  mimetype: string;
  bytes: Uint8Array;
  signal: AbortSignal;
}

export interface ComposioFileUploadDependencies {
  fetch?: typeof fetch;
}

/** MD5 as Composio's upload request wants it: lowercase hex of the raw bytes. */
export async function md5Hex(bytes: Uint8Array): Promise<string> {
  return encodeHex(await crypto.subtle.digest("MD5", bytes));
}

export async function uploadFileForTool(
  client: Pick<ComposioClient, "requestFileUpload">,
  input: ComposioFileUploadInput,
  deps: ComposioFileUploadDependencies = {},
): Promise<ComposioUploadedFile> {
  const ticket = await client.requestFileUpload({
    toolkit: input.toolkit,
    tool: input.tool,
    filename: input.filename,
    mimetype: input.mimetype,
    md5: await md5Hex(input.bytes),
  });
  const response = await (deps.fetch ?? fetch)(ticket.presignedUrl, {
    method: "PUT",
    // Content-Type is the only header the presign signs; anything else 403s.
    headers: { "content-type": input.mimetype },
    body: input.bytes,
    signal: input.signal,
  });
  if (!response.ok) {
    throw new ComposioError(response.status >= 500 ? "composio_unavailable" : "composio_rejected", response.status);
  }
  return { name: input.filename, mimetype: input.mimetype, s3key: ticket.key };
}
