import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseDatetimeLocal } from "@/features/scheduled";
import { AMBIGUOUS_TIME_NOTE, shortcutInstant, type ShortcutName } from "../domain/scheduleRules";

export function useScheduleSelection(selectionKey: string | null, timeZone: string) {
  const { t } = useTranslation("post");
  const ambiguousNote = t("tiktokReview.dstAmbiguous", AMBIGUOUS_TIME_NOTE);
  const [mode, setMode] = useState<"now" | "scheduled">("now");
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [scheduleNote, setScheduleNote] = useState<string | null>(null);

  function onNow() {
    setMode("now");
    setScheduledAt(null);
    setScheduleLocal("");
    setScheduleNote(null);
  }

  useEffect(() => { onNow(); }, [selectionKey]);

  function onShortcut(name: ShortcutName) {
    const resolved = shortcutInstant(name, new Date(), timeZone);
    if (!resolved.ok) {
      setScheduleNote(resolved.resolution ?? t("tiktokReview.timeInvalid", "That time is not valid."));
      return;
    }
    setMode("scheduled");
    setScheduledAt(resolved.iso);
    setScheduleLocal(toDatetimeLocal(resolved.iso));
    setScheduleNote(resolved.resolution === AMBIGUOUS_TIME_NOTE ? ambiguousNote : resolved.resolution);
  }

  function onScheduleLocal(value: string) {
    setScheduleLocal(value);
    setMode("scheduled");
    if (!value) {
      setScheduledAt(null);
      setScheduleNote(null);
      return;
    }
    const parsed = parseDatetimeLocal(value);
    if (parsed.ok === false) {
      setScheduledAt(null);
      setScheduleNote(parsed.reason === "nonexistent"
        ? t("tiktokReview.dstGap", "That time does not exist because clocks change on that day.")
        : t("tiktokReview.timeInvalid", "That time is not valid."));
      return;
    }
    setScheduledAt(parsed.when.toISOString());
    setScheduleNote(parsed.ambiguous ? ambiguousNote : null);
  }

  return { mode, scheduledAt, scheduleLocal, scheduleNote, onNow, onShortcut, onScheduleLocal };
}

function toDatetimeLocal(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
