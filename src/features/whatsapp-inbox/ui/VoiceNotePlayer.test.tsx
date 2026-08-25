import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceNotePlayer } from "./VoiceNotePlayer";

describe("VoiceNotePlayer", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses media_metadata.duration_seconds when the backend supplied it", () => {
    render(<VoiceNotePlayer src="https://signed.example/voice.ogg" durationSeconds={90} />);
    expect(screen.getByTestId("wa-voice-time")).toHaveTextContent("0:00 / 1:30");
    expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
  });

  it("falls back to the loaded element's durationchange", () => {
    const { container } = render(<VoiceNotePlayer src="https://signed.example/voice.ogg" />);
    const audio = container.querySelector("audio");
    expect(audio).toBeTruthy();
    Object.defineProperty(audio, "duration", { configurable: true, value: 34 });
    fireEvent(audio as HTMLAudioElement, new Event("durationchange"));
    expect(screen.getByTestId("wa-voice-time")).toHaveTextContent("0:00 / 0:34");
  });

  // Regression, 2026-08-25: the spec said the player "always shows a duration". Many
  // historical voice notes have neither metadata nor a browser-reported length, so
  // a fabricated total would lie. Elapsed-only is the honest fallback.
  it("shows elapsed-only when neither duration source is available", () => {
    const { container } = render(<VoiceNotePlayer src="https://signed.example/voice.ogg" />);
    expect(screen.getByTestId("wa-voice-time")).toHaveTextContent("0:00");
    expect(screen.getByTestId("wa-voice-time")).not.toHaveTextContent("/");
    expect(screen.queryByRole("slider", { name: "Seek" })).not.toBeInTheDocument();

    const audio = container.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "currentTime", { configurable: true, value: 5 });
    fireEvent(audio, new Event("timeupdate"));
    expect(screen.getByTestId("wa-voice-time")).toHaveTextContent("0:05");
    expect(screen.getByTestId("wa-voice-time")).not.toHaveTextContent("/");
  });

  it("prefers metadata duration over the loaded element", () => {
    const { container } = render(
      <VoiceNotePlayer src="https://signed.example/voice.ogg" durationSeconds={12} />,
    );
    const audio = container.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "duration", { configurable: true, value: 99 });
    fireEvent(audio, new Event("durationchange"));
    expect(screen.getByTestId("wa-voice-time")).toHaveTextContent("0:00 / 0:12");
  });
});
