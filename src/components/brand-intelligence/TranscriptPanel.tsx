import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Mic, ArrowDown } from "lucide-react";
import { useState } from "react";

interface TranscriptPanelProps {
  transcript: string;
  language: string;
  duration: number;
  onUseTranscript: (text: string) => void;
}

export function TranscriptPanel({ transcript, language, duration, onUseTranscript }: TranscriptPanelProps) {
  const { t } = useTranslation("analytics");
  const [text, setText] = useState(transcript);

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <Card className="animate-[fadeSlideUp_0.3s_ease-out]">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Mic className="w-4 h-4 text-foreground" />
          <span className="text-sm font-medium">{t("transcript.title", "Transcript")}</span>
          <Badge variant="secondary" className="text-[10px]">🌐 {language || t("transcript.auto", "Auto")}</Badge>
          {duration > 0 && (
            <Badge variant="outline" className="text-[10px]">⏱ {formatDuration(duration)}</Badge>
          )}
        </div>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          className="text-sm resize-none"
        />

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">{t("transcript.charCount", "{{count}} characters", { count: text.length })}</span>
          <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={() => onUseTranscript(text)}>
            {t("actions.useForGeneration", "Use for Content Generation")} <ArrowDown className="w-3 h-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
