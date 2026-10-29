/**
 * Where an uploaded object lives and what it is called. Shared by the
 * edge-function upload and the browser-direct upload so both paths write the
 * same folders and names.
 */

// Sanitize email for folder name (replace special chars)
export function sanitizeEmailForFolder(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, "_at_")
    .replace(/\./g, "_")
    .replace(/[^a-z0-9_-]/g, "_");
}

// Get today's date in YYYY-MM-DD format
export function getTodayFolder(today = new Date()): string {
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Postora naming convention: postora_<date>_<userId>_<seq>. */
export function mediaPublicId(uploadDate: string, userId: string, sequence: number | string): string {
  return `postora_${uploadDate}_${userId}_${sequence}`;
}
