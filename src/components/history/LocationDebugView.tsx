import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, MapPin } from "lucide-react";
import { useTranslation } from "react-i18next";

interface LocationDebug {
  platform?: string;
  publish_flow?: string;
  selected_location_id?: string | null;
  selected_location_object?: Record<string, unknown> | null;
  skipped_reason?: string | null;

  // IG-only
  eligibility_check_started?: boolean;
  eligibility_check_result?: boolean | null;
  eligibility_check_reason?: string | null;

  // Common send fields
  media_container_endpoint?: string | null;
  media_container_body_had_location_id?: boolean;
  media_container_location_id_sent?: string | null;
  meta_media_create_success?: boolean | null;
  meta_media_create_error?: { code?: number; subcode?: number; type?: string; message?: string } | null;
  retry_without_location_attempted?: boolean;
  retry_without_location_success?: boolean | null;

  // Threads-only
  capability_can_use_location_tagging?: boolean | null;
  native_ok?: boolean;
  container_endpoint?: string | null;
  container_params_had_location_id?: boolean;
  container_location_id_sent?: string | null;
  create_container_success?: boolean | null;
  create_container_error?: { code?: number; subcode?: number; type?: string; message?: string } | null;
  publish_success?: boolean | null;
  publish_error?: { code?: number; subcode?: number; type?: string; message?: string } | null;

  // Verification
  post_publish_verify_attempted?: boolean;
  post_publish_verify_result?: string | null;
  post_publish_verify_error?: string | null;
  post_publish_location_field?: unknown;

  // Final
  final_reason_location_not_visible?: string | null;
}

const finalReasonLabels: Record<string, { label: string; variant: "default" | "destructive" | "secondary" | "outline" }> = {
  no_location_selected: { label: "No location selected", variant: "secondary" },
  reference_only_osm: { label: "Reference-only (OSM)", variant: "destructive" },
  non_native_threads_source: { label: "Non-native Threads source", variant: "destructive" },
  not_taggable_by_meta: { label: "Not taggable by Meta", variant: "destructive" },
  location_id_not_included_in_request: { label: "location_id not in request", variant: "destructive" },
  meta_rejected_location: { label: "Meta rejected location", variant: "destructive" },
  retried_without_location: { label: "Retried without location", variant: "destructive" },
  meta_accepted_but_silent_drop: { label: "Meta accepted but silently dropped", variant: "destructive" },
  verification_not_supported: { label: "Verification unsupported", variant: "outline" },
  verification_failed: { label: "Verification failed", variant: "outline" },
  unknown: { label: "Unknown", variant: "outline" },
};

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

export function LocationDebugView({ debug }: { debug: LocationDebug }) {
  const { t } = useTranslation("history");
  if (!debug) return null;
  const isIG = debug.platform === "instagram";
  const isThreads = debug.platform === "threads";
  const finalReason = debug.final_reason_location_not_visible;
  const finalMeta = finalReason ? finalReasonLabels[finalReason] || finalReasonLabels.unknown : null;

  const locObj = (debug.selected_location_object || {}) as Record<string, unknown>;
  const locName = (locObj.name as string) || (locObj.title as string) || null;
  const locSource = (locObj.source as string) || null;

  const errMsg = (e?: { code?: number; subcode?: number; message?: string } | null) =>
    e ? `${e.code ?? "?"}${e.subcode ? "/" + e.subcode : ""}: ${e.message || ""}` : "—";

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors mt-1">
        <ChevronDown className="w-3 h-3" />
        <MapPin className="w-3 h-3" />
        {t("debug.showLocationDebug", "Show location debug")}
        {finalMeta && (
          <Badge variant={finalMeta.variant} className="ml-1 text-[9px] h-4">
            {finalMeta.label}
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="bg-muted/40 rounded-md p-2 mt-1 space-y-0.5">
          <Row label="Platform">
            {debug.platform || "—"}
            {debug.publish_flow ? ` (${debug.publish_flow})` : ""}
          </Row>
          <Row label="Selected location">
            {debug.selected_location_id ? (
              <>
                {debug.selected_location_id}
                {locName ? ` — ${locName}` : ""}
                {locSource ? ` [${locSource}]` : ""}
              </>
            ) : (
              "— none —"
            )}
          </Row>
          {debug.skipped_reason && (
            <Row label="Skipped reason">{debug.skipped_reason}</Row>
          )}

          {isIG && (
            <>
              <Row label="Eligibility checked">
                <YesNoBadge value={debug.eligibility_check_started} />
              </Row>
              <Row label="Eligible (taggable)">
                <YesNoBadge value={debug.eligibility_check_result} />
                {debug.eligibility_check_reason ? ` (${debug.eligibility_check_reason})` : ""}
              </Row>
              <Row label="Endpoint">{debug.media_container_endpoint || "—"}</Row>
              <Row label="location_id in request">
                <YesNoBadge value={debug.media_container_body_had_location_id} />
                {debug.media_container_location_id_sent
                  ? ` (${debug.media_container_location_id_sent})`
                  : ""}
              </Row>
              <Row label="Meta /media create">
                <YesNoBadge value={debug.meta_media_create_success} />
                {debug.meta_media_create_error && (
                  <span className="text-destructive ml-2">{errMsg(debug.meta_media_create_error)}</span>
                )}
              </Row>
              <Row label="Retried w/o location">
                <YesNoBadge value={debug.retry_without_location_attempted} />
                {debug.retry_without_location_attempted && (
                  <>
                    {" "}→ <YesNoBadge value={debug.retry_without_location_success} />
                  </>
                )}
              </Row>
            </>
          )}

          {isThreads && (
            <>
              <Row label="Capability flag">
                <YesNoBadge value={debug.capability_can_use_location_tagging} />
              </Row>
              <Row label="Native OK">
                <YesNoBadge value={debug.native_ok} />
              </Row>
              <Row label="Endpoint">{debug.container_endpoint || "—"}</Row>
              <Row label="location_id in request">
                <YesNoBadge value={debug.container_params_had_location_id} />
                {debug.container_location_id_sent
                  ? ` (${debug.container_location_id_sent})`
                  : ""}
              </Row>
              <Row label="Container create">
                <YesNoBadge value={debug.create_container_success} />
                {debug.create_container_error && (
                  <span className="text-destructive ml-2">{errMsg(debug.create_container_error)}</span>
                )}
              </Row>
              <Row label="Publish">
                <YesNoBadge value={debug.publish_success} />
                {debug.publish_error && (
                  <span className="text-destructive ml-2">{errMsg(debug.publish_error)}</span>
                )}
              </Row>
            </>
          )}

          <Row label="Verification result">
            {debug.post_publish_verify_result || "—"}
            {debug.post_publish_verify_error ? ` (${debug.post_publish_verify_error})` : ""}
          </Row>
          {debug.post_publish_location_field !== null &&
            debug.post_publish_location_field !== undefined && (
              <Row label="Returned location field">
                {typeof debug.post_publish_location_field === "string"
                  ? debug.post_publish_location_field
                  : JSON.stringify(debug.post_publish_location_field)}
              </Row>
            )}

          {finalMeta && (
            <div className="pt-2 mt-1 border-t border-border/60 flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">{t("debug.finalReason", "Final reason:")}</span>
              <Badge variant={finalMeta.variant} className="text-[10px]">
                {finalMeta.label}
              </Badge>
              <code className="text-[10px] text-muted-foreground">({finalReason})</code>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}