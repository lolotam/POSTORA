import { useTranslation } from "react-i18next";
import "@/i18n";
import { Label } from "@/components/ui/label";
import { useConnectorConnections } from "@/features/connectors";
import { connectorDefinition, type ConnectorType } from "@/lib/connectorRegistry";

interface ConnectionPickerProps {
  connectorType: ConnectorType;
  /** The selected account's workspace; null when it has none. */
  workspaceId: string | null;
  /** True while that workspace is still being resolved — "not yet known" is
   *  not the same claim as "this account has none". */
  isWorkspaceLoading?: boolean;
  value: string | null;
  onChange: (connectionId: string | null) => void;
}

const SELECT_CLASS = "flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

/**
 * Which connected account an agent tool runs as. Only `active` connections of
 * the tool's own connector type and the account's own workspace are offered:
 * the tenancy trigger refuses anything else, and 13 of 116 production
 * accounts have no workspace at all (plan Task 1).
 */
export function ConnectionPicker({
  connectorType,
  workspaceId,
  isWorkspaceLoading = false,
  value,
  onChange,
}: ConnectionPickerProps) {
  const { t } = useTranslation("automation");
  const connections = useConnectorConnections(workspaceId);
  const label = connectorDefinition(connectorType).label;

  if (workspaceId === null) {
    if (isWorkspaceLoading) return null;
    return (
      <p className="text-xs text-destructive">
        {t("picker.noWorkspace", "This account has no workspace; connect it from Profiles first")}
      </p>
    );
  }

  const options = (connections.data ?? []).filter(
    (row) => row.connector_type === connectorType && row.status === "active",
  );

  return (
    <div className="space-y-1.5">
      <Label htmlFor="connector-connection" className="text-xs">{t("form.connection", "Connection")}</Label>
      <select
        id="connector-connection"
        className={SELECT_CLASS}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">{connections.isLoading ? t("common:loading", "Loading…") : t("picker.selectAccount", "Select a connected {{label}} account", { label })}</option>
        {options.map((row) => (
          <option key={row.id} value={row.id}>
            {row.external_account_label ?? row.id}
          </option>
        ))}
      </select>
      {connections.error ? (
        <p className="text-xs text-destructive">
          {t("errors.connectionsNone", "Connections could not be loaded, so none can be chosen here.")}
        </p>
      ) : (
        !connections.isLoading && options.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("picker.noneYet", "No connected {{label}} account yet — connect one on Settings → Integrations first.", { label })}
          </p>
        )
      )}
    </div>
  );
}
