/**
 * Camera-motion preset and prompt-assembly tests.
 *
 * Per-model parameter handling lives in `higgsfieldModelSpecs` and is tested
 * there.
 *
 * @module lib/higgsfieldModels.test
 */

import { describe, it, expect } from "vitest";
import {
  CAMERA_MOTION_PRESETS,
  buildVideoPrompt,
  getCameraMotionPreset,
} from "./higgsfieldModels";

describe("getCameraMotionPreset", () => {
  it("should return the preset matching an id", () => {
    expect(getCameraMotionPreset("orbit_3d")?.label).toBe("3D Orbit");
  });

  it("should return null for an unknown id", () => {
    expect(getCameraMotionPreset("barrel_roll")).toBeNull();
  });

  it("should return null for null or empty input", () => {
    expect(getCameraMotionPreset(null)).toBeNull();
    expect(getCameraMotionPreset("")).toBeNull();
  });

  it("should expose a unique id for every preset", () => {
    const ids = CAMERA_MOTION_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildVideoPrompt", () => {
  it("should append the motion fragment to the prompt", () => {
    expect(buildVideoPrompt("a gaming laptop on a desk", "orbit_3d")).toBe(
      "a gaming laptop on a desk, camera slowly orbits around the subject in a smooth 3D arc"
    );
  });

  it("should return the prompt unchanged for the static preset", () => {
    expect(buildVideoPrompt("a gaming laptop", "static")).toBe("a gaming laptop");
  });

  it("should return the prompt unchanged for an unknown preset", () => {
    expect(buildVideoPrompt("a gaming laptop", "nope")).toBe("a gaming laptop");
  });

  it("should return the prompt unchanged when no preset is given", () => {
    expect(buildVideoPrompt("a gaming laptop")).toBe("a gaming laptop");
    expect(buildVideoPrompt("a gaming laptop", null)).toBe("a gaming laptop");
  });

  it("should collapse surrounding whitespace", () => {
    expect(buildVideoPrompt("  a   gaming   laptop  ", "static")).toBe("a gaming laptop");
  });

  it("should not double up punctuation when the prompt already ends in a separator", () => {
    expect(buildVideoPrompt("a gaming laptop.", "push_in")).toBe(
      "a gaming laptop. camera pushes in slowly toward the subject"
    );
  });

  it("should return just the fragment when the prompt is empty", () => {
    expect(buildVideoPrompt("", "push_in")).toBe("camera pushes in slowly toward the subject");
  });

  it("should return an empty string when both inputs are empty", () => {
    expect(buildVideoPrompt("", "static")).toBe("");
  });
});


