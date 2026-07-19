import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  listLinkedInDestinations,
  normalizeLinkedInDestinationSelections,
  selectedLinkedInDestinationIds,
} from "./linkedinDestinations.ts";

const accountMetadata = {
  linkedin_pages: [{ id: "page-1", name: "Acme Inc." }],
};

Deno.test("lists personal and commercial LinkedIn destinations", () => {
  assertEquals(listLinkedInDestinations("Jane Doe", accountMetadata), [
    { id: "personal", name: "Jane Doe", type: "personal" },
    { id: "page-1", name: "Acme Inc.", type: "commercial" },
  ]);
});

Deno.test("rejects a commercial destination not administered by the account", () => {
  assertThrows(
    () =>
      normalizeLinkedInDestinationSelections(
        [{ account_id: "account-1", destination_id: "page-2" }],
        [{ id: "account-1", platform: "linkedin", account_metadata: accountMetadata }],
      ),
    Error,
    "page-2",
  );
});

Deno.test("deduplicates valid personal and commercial selections", () => {
  assertEquals(
    normalizeLinkedInDestinationSelections(
      [
        { account_id: "account-1", destination_id: "personal" },
        { account_id: "account-1", destination_id: "page-1" },
        { account_id: "account-1", destination_id: "page-1" },
      ],
      [{ id: "account-1", platform: "linkedin", account_metadata: accountMetadata }],
    ),
    [
      { account_id: "account-1", destination_id: "personal" },
      { account_id: "account-1", destination_id: "page-1" },
    ],
  );
});

Deno.test("resolves only destinations selected for the current account", () => {
  assertEquals(
    selectedLinkedInDestinationIds(
      [
        { account_id: "account-1", destination_id: "personal" },
        { account_id: "account-1", destination_id: "page-1" },
        { account_id: "account-2", destination_id: "page-2" },
      ],
      "account-1",
    ),
    ["personal", "page-1"],
  );
});
