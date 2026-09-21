import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, Hash } from "lucide-react";
import { useTranslation } from "react-i18next";

interface TopicTagDebug {
  raw?: string | null;
  cleaned?: string | null;
  sent?: boolean;
  accepted?: boolean;
  returned_by_meta?: string | null;
}

function YesNoBadge({ value }: { value: boolean | null | undefined }) {
  if (value === true) return <Badge variant="default" className="text-[10px] h-4">yes</Badge>;
  if (value === false) return <Badge variant="destructive" className="text-[10px] h-4">no</Badge>;
  return <Badge variant="outline" className="text-[10px] h-4">—</Badge>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-2 items-start py-1 border-b border-border/40 last:border-0">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="text-[11px] font-mono break-all">{children}</span>
    </div>
  );
}

export function TopicTagDebugView({ debug }: { debug: TopicTagDebug }) {
  const { t } = useTranslation("history");
  if (!debug) return null;
  const headlineLabel = debug.accepted
    ? t("debug.accepted", "Accepted")
    : debug.sent
    ? t("debug.sent", "Sent")
    : debug.raw
    ? t("debug.cleanedToEmpty", "Cleaned to empty")
    : t("debug.notUsed", "Not used");
  const headlineVariant: "default" | "destructive" | "secondary" | "outline" =
    debug.accepted ? "default" : debug.sent ? "outline" : debug.raw ? "destructive" : "secondary";

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors mt-1">
        <ChevronDown className="w-3 h-3" />
        <Hash className="w-3 h-3" />
        {t("debug.showTopicTagDebug", "Show topic tag debug")}
        <Badge variant={headlineVariant} className="ms-1 text-[9px] h-4">
          {headlineLabel}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="bg-muted/40 rounded-md p-2 mt-1 space-y-0.5">
          <Row label={t("debug.rawInput", "Raw input")}>{debug.raw || "—"}</Row>
          <Row label={t("debug.cleanedValue", "Cleaned value")}>{debug.cleaned || "—"}</Row>
          <Row label={t("debug.sentToMeta", "Sent to Meta")}>
            <YesNoBadge value={debug.sent} />
          </Row>
          <Row label={t("debug.accepted", "Accepted")}>
            <YesNoBadge value={debug.accepted} />
          </Row>
          <Row label={t("debug.returnedByMeta", "Returned by Meta")}>
            {debug.returned_by_meta ?? "—"}
          </Row>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}