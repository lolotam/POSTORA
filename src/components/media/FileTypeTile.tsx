import {
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileType,
  Image as ImageIcon,
  Music,
  Presentation,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaIcon, MediaKind } from "@/lib/mediaTypes";

const ICONS: Record<MediaIcon, typeof FileText> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  pdf: FileText,
  word: FileType,
  excel: FileSpreadsheet,
  powerpoint: Presentation,
  text: FileText,
  code: FileCode,
  archive: FileArchive,
};

const KIND_CLASS: Record<MediaKind, string> = {
  image: "bg-sky-500/15 text-sky-700",
  video: "bg-violet-500/15 text-violet-700",
  audio: "bg-amber-500/15 text-amber-800",
  document: "bg-emerald-500/15 text-emerald-800",
  archive: "bg-orange-500/15 text-orange-800",
};

export function FileTypeTile({
  kind,
  icon,
  extension,
  className,
}: {
  kind: MediaKind;
  icon: MediaIcon;
  extension: string;
  className?: string;
}) {
  const Icon = ICONS[icon] ?? FileText;
  return (
    <div className={cn("flex h-full w-full flex-col items-center justify-center gap-1", KIND_CLASS[kind], className)}>
      <Icon className="h-8 w-8" aria-hidden />
      {extension ? (
        <span className="rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground">
          {extension}
        </span>
      ) : null}
    </div>
  );
}
