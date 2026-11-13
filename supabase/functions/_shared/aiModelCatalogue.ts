// The model catalogue, grouped by credential kind.
//
// WHY a shared helper
// The catalogue is keyed by credential kind: one provider can serve an API key
// and a subscription login with the same model_id, so the same model exists
// twice. Every reader of the catalogue has to ask for one kind or the other,
// and a reader that asks for the wrong one sees the same model twice.
//
// WHY the API-key list is unchanged
// The API-key consumers read the API-key list and only the API-key list. The
// grouping keeps that list exactly as it was and puts the subscription rows in
// their own list, so nothing that reads the API-key catalogue sees a second,
// identical row.

export interface CatalogueRow {
  /** The credential kind. A row with no value is an API-key row. */
  auth_method?: string | null;
}

/** The catalogue split by credential kind. */
export interface GroupedCatalogue<T> {
  /** The API-key rows. */
  models: T[];
  /** The subscription rows. */
  oauthModels: T[];
}

/**
 * Splits the catalogue rows into the API-key list and the subscription list.
 *
 * A row whose auth_method is missing or unknown is an API-key row: the column
 * did not exist before the catalogue was keyed by credential kind, and an
 * unknown value must not silently disappear from the list the admin already
 * reads.
 */
export function groupCatalogueRows<T extends CatalogueRow>(rows: T[]): GroupedCatalogue<T> {
  const models: T[] = [];
  const oauthModels: T[] = [];
  for (const row of rows) {
    if (row.auth_method === "oauth") oauthModels.push(row);
    else models.push(row);
  }
  return { models, oauthModels };
}
