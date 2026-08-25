import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface VoiceNotePlayerProps {
  src: string;
  durationSeconds?: number | null;
  className?: string;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function formatClock(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

export function VoiceNotePlayer({ src, durationSeconds, className }: VoiceNotePlayerProps): JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [elementDuration, setElementDuration] = useState<number | null>(null);

  const metadataDuration = finitePositive(durationSeconds);
  const loadedDuration = finitePositive(elementDuration);
  const total = metadataDuration ?? loadedDuration;

  const timeLabel = useMemo(() => {
    if (total == null) return formatClock(elapsed);
    return `${formatClock(elapsed)} / ${formatClock(total)}`;
  }, [elapsed, total]);

  useEffect(() => {
    setElapsed(0);
    setPlaying(false);
    setElementDuration(null);
  }, [src]);

  const handlePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      return;
    }
    void audio.play();
  };

  const handleSeek = (value: string) => {
    const audio = audioRef.current;
    if (!audio || total == null) return;
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    audio.currentTime = next;
    setElapsed(next);
  };

  return (
    <div className={cn("flex min-w-[12rem] items-center gap-2 py-1", className)}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime || 0)}
        onDurationChange={(event) => setElementDuration(event.currentTarget.duration)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={playing ? "Pause" : "Play"}
        className="h-8 w-8 shrink-0"
        onClick={handlePlayPause}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      {total != null && (
        <input
          type="range"
          min={0}
          max={total}
          step={0.1}
          value={Math.min(elapsed, total)}
          aria-label="Seek"
          className="h-1 w-24 accent-current"
          onChange={(event) => handleSeek(event.target.value)}
        />
      )}
      <span data-testid="wa-voice-time" className="text-[11px] tabular-nums text-current/80">
        {timeLabel}
      </span>
    </div>
  );
}
