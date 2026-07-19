export type LinkedInDestination = {
  id: string;
  name: string;
  type: "personal" | "commercial";
};

export type LinkedInDestinationSelection = {
  account_id: string;
  destination_id: string;
};

type LinkedInAccount = {
  id: string;
  platform: string;
  account_metadata?: { linkedin_pages?: Array<{ id?: unknown; name?: unknown }> } | null;
};

export function listLinkedInDestinations(
  accountName: string,
  accountMetadata: LinkedInAccount["account_metadata"],
): LinkedInDestination[] {
  const pages = accountMetadata?.linkedin_pages ?? [];
  const commercialDestinations = pages.flatMap((page) => {
    if (typeof page.id !== "string") return [];
    return [{
      id: page.id,
      name: typeof page.name === "string" ? page.name : "Company Page",
      type: "commercial" as const,
    }];
  });

  return [
    { id: "personal", name: accountName || "LinkedIn User", type: "personal" },
    ...commercialDestinations,
  ];
}

export function normalizeLinkedInDestinationSelections(
  selections: unknown,
  accounts: LinkedInAccount[],
): LinkedInDestinationSelection[] {
  if (!Array.isArray(selections)) {
    throw new Error("LinkedIn destinations must be an array");
  }

  const uniqueSelections = new Map<string, LinkedInDestinationSelection>();

  for (const selection of selections) {
    if (
      typeof selection !== "object" ||
      selection === null ||
      !("account_id" in selection) ||
      !("destination_id" in selection) ||
      typeof selection.account_id !== "string" ||
      typeof selection.destination_id !== "string"
    ) {
      throw new Error("LinkedIn destination selection is invalid");
    }

    const account = accounts.find((candidate) => candidate.id === selection.account_id);
    const destinationIds = account?.platform === "linkedin"
      ? listLinkedInDestinations("", account.account_metadata).map((destination) => destination.id)
      : [];

    if (!destinationIds.includes(selection.destination_id)) {
      throw new Error(`LinkedIn destination is not available: ${selection.destination_id}`);
    }

    uniqueSelections.set(`${selection.account_id}|${selection.destination_id}`, selection);
  }

  return [...uniqueSelections.values()];
}

export function selectedLinkedInDestinationIds(
  selections: unknown,
  accountId: string,
): string[] {
  if (!Array.isArray(selections)) return [];

  const destinationIds = selections.flatMap((selection) => {
    if (
      typeof selection !== "object" ||
      selection === null ||
      !("account_id" in selection) ||
      !("destination_id" in selection) ||
      selection.account_id !== accountId ||
      typeof selection.destination_id !== "string"
    ) {
      return [];
    }

    return [selection.destination_id];
  });

  return [...new Set(destinationIds)];
}
