/**
 * Camera-motion presets and prompt assembly for AI video generation.
 *
 * These are the app's own creative shorthand, not something the provider
 * exposes â€” Higgsfield takes camera direction as prose in the prompt. Per-model
 * parameters (resolution, aspect ratio, duration, genre, â€¦) come from the
 * catalog instead; see `lib/higgsfieldModelSpecs`.
 *
 * @module lib/higgsfieldModels
 */

export interface CameraMotionPreset {
  id: string;
  label: string;
  labelAr: string;
  /** Appended to the user's prompt. Empty means "add nothing". */
  promptFragment: string;
}

export const CAMERA_MOTION_PRESETS: CameraMotionPreset[] = [
  {
    id: "static",
    label: "Static",
    labelAr: "Ø«Ø§Ø¨Øª",
    promptFragment: "",
  },
  {
    id: "orbit_3d",
    label: "3D Orbit",
    labelAr: "Ø¯ÙˆØ±Ø§Ù† Ø«Ù„Ø§Ø«ÙŠ Ø§Ù„Ø£Ø¨Ø¹Ø§Ø¯",
    promptFragment: "camera slowly orbits around the subject in a smooth 3D arc",
  },
  {
    id: "dolly_zoom",
    label: "Dolly Zoom",
    labelAr: "Ø¯ÙˆÙ„Ù„ÙŠ Ø²ÙˆÙ…",
    promptFragment: "dolly zoom effect, camera pushes in while the lens zooms out",
  },
  {
    id: "crane_up",
    label: "Crane Up",
    labelAr: "Ø±ÙØ¹ Ø§Ù„ÙƒØ§Ù…ÙŠØ±Ø§",
    promptFragment: "camera cranes upward, revealing the scene from above",
  },
  {
    id: "push_in",
    label: "Push In",
    labelAr: "Ø§Ù‚ØªØ±Ø§Ø¨",
    promptFragment: "camera pushes in slowly toward the subject",
  },
  {
    id: "pull_out",
    label: "Pull Out",
    labelAr: "Ø§Ø¨ØªØ¹Ø§Ø¯",
    promptFragment: "camera pulls out steadily, widening the frame",
  },
];

export function getCameraMotionPreset(id: string | null | undefined): CameraMotionPreset | null {
  if (!id) return null;
  return CAMERA_MOTION_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Combine the user's prompt with a camera-motion fragment.
 *
 * An unknown or motionless preset returns the prompt unchanged rather than
 * appending an empty clause.
 */
export function buildVideoPrompt(
  basePrompt: string,
  cameraMotionId?: string | null
): string {
  const base = (basePrompt ?? "").replace(/\s+/g, " ").trim();
  const preset = getCameraMotionPreset(cameraMotionId);
  const fragment = preset?.promptFragment?.trim();

  if (!fragment) return base;
  if (!base) return fragment;

  // Avoid doubling up punctuation when the prompt already ends in a separator.
  const separator = /[.,;:!?]$/.test(base) ? " " : ", ";
  return `${base}${separator}${fragment}`;
}

