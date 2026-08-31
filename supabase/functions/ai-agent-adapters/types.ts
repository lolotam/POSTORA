import {
  CONNECTOR_CAPABILITY_NAMES,
  type ConnectorCapability,
  type ConnectorType,
} from "../_shared/connectorRegistry.ts";

export const CAPABILITIES = CONNECTOR_CAPABILITY_NAMES;

export type Capability = ConnectorCapability;
export type ConnectorAction = "execute" | "test_connection";
export type ConnectorMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ConnectorTool {
  id: string;
  connector_type: ConnectorType;
  settings: Record<string, unknown>;
  permissions: Record<string, unknown>;
  read_only_mode: boolean;
}

export interface ExecuteConnectorRequest {
  action: ConnectorAction;
  capability?: Capability;
  parameters: Record<string, unknown>;
  /** Defensive internal seam. The public schema does not accept this field. */
  method?: ConnectorMethod;
}

export interface ConnectorInvocation {
  tool: ConnectorTool;
  credentials: Record<string, unknown>;
  request: ExecuteConnectorRequest;
}

export interface AdapterLogEvent {
  event: "connector_refused" | "connector_failure";
  vendor: string;
  operation: string;
  error_code: string;
  vendor_status?: number;
}

export interface AdapterDependencies {
  fetch: typeof fetch;
  assertPublicHttpsUrl(rawUrl: string): Promise<URL>;
  timeoutMs: number;
  maxRedirects: number;
  log(event: AdapterLogEvent): void;
}

export interface ConnectorFailure {
  ok: false;
  vendor: string;
  error: {
    code: string;
    message: string;
    vendor_status?: number;
  };
}

export interface ConnectorDataSuccess {
  ok: true;
  vendor: string;
  action: "execute";
  capability: Capability;
  data: unknown;
}

export interface ConnectorTestSuccess {
  ok: true;
  vendor: string;
  action: "test_connection";
  capabilities: Capability[];
  read_only: boolean;
}

export type ConnectorResult = ConnectorFailure | ConnectorDataSuccess | ConnectorTestSuccess;

export interface ConnectorAdapter {
  id: ConnectorType;
  capabilities: readonly Capability[];
  execute(
    invocation: ConnectorInvocation,
    dependencies: AdapterDependencies,
  ): Promise<ConnectorResult>;
  testConnection(
    invocation: ConnectorInvocation,
    dependencies: AdapterDependencies,
  ): Promise<ConnectorResult>;
}
