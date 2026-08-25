import type { WhatsAppConnectionMode } from "./whatsappCapabilities";

export const MAX_DURATION_SECONDS = 300;
export const MAX_BYTES = 16 * 1024 * 1024;

const MIME_PREFERENCE = [
  "audio/ogg;codecs=opus",
  "audio/webm;codecs=opus",
  "audio/webm",
] as const;

export function pickRecordingMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const mime of MIME_PREFERENCE) {
    if (isTypeSupported(mime)) return mime;
  }
  return null;
}

export function canRecordForMode(
  mode: WhatsAppConnectionMode,
  isTypeSupported: (type: string) => boolean,
): boolean {
  const mime = pickRecordingMimeType(isTypeSupported);
  if (!mime) return false;
  if (mode === "evolution_qr") return true;
  // Cloud API / coexistence have no verified PTT send path here. A native
  // ogg/opus recording would at least *be* a WhatsApp voice note; WebM would
  // render as a paperclip and look like success. Meta's audio.voice:true
  // upload is still out of scope — this only refuses the dishonest WebM case.
  if (mode === "cloud_api" || mode === "coexistence") {
    return mime.startsWith("audio/ogg");
  }
  return false;
}
