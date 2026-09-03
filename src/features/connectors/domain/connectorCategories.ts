import {
  CONNECTOR_CATEGORY_LABELS,
  CONNECTOR_TYPES,
  connectorDefinition,
  type ConnectorCategory,
  type ConnectorType,
} from "@/lib/connectorRegistry";

/**
 * Tab order for the connectors surface (spec §9.1). The order is the product
 * decision; every label comes from the registry so a renamed category is
 * renamed in one place.
 */
export const CATEGORY_TABS: readonly { key: ConnectorCategory; label: string }[] = [
  { key: "ecommerce_payments", label: CONNECTOR_CATEGORY_LABELS.ecommerce_payments },
  { key: "productivity_crm", label: CONNECTOR_CATEGORY_LABELS.productivity_crm },
  { key: "databases", label: CONNECTOR_CATEGORY_LABELS.databases },
  { key: "automation", label: CONNECTOR_CATEGORY_LABELS.automation },
] as const;

/** The registry types filed under a category, in registry order. */
export function typesInCategory(category: ConnectorCategory): ConnectorType[] {
  return CONNECTOR_TYPES.filter((type) => connectorDefinition(type).category === category);
}
