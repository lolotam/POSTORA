import { describe, expect, it } from "vitest";
import {
  applyOptimisticDealMove,
  dealStatusForStage,
  groupDealsByStage,
  isLostStage,
  isOpenStage,
  isWonStage,
  sortDealsByPosition,
  validateDeal,
  validateDealChanges,
} from "../whatsappPipeline";

const stages = {
  open: { id: "stage-open", stage_type: "open" as const },
  won: { id: "stage-won", stage_type: "won" as const },
  lost: { id: "stage-lost", stage_type: "lost" as const },
};

const deal = (
  id: string,
  stageId: string,
  position: number,
  status: "open" | "won" | "lost" = "open",
) => ({ id, stage_id: stageId, position, status });

describe("validateDeal", () => {
  it("returns normalized deal values when every required field is valid", () => {
    expect(validateDeal({
      contactId: " contact-1 ",
      title: " Enterprise renewal ",
      amount: 1250.5,
      currency: "kwd",
    })).toEqual({
      success: true,
      value: {
        contactId: "contact-1",
        title: "Enterprise renewal",
        amount: 1250.5,
        currency: "KWD",
      },
    });
  });

  it("returns field-level errors for a missing contact and blank title", () => {
    const validation = validateDeal({
      contactId: " ",
      title: "   ",
      amount: 0,
      currency: "USD",
    });

    expect(validation).toEqual({
      success: false,
      errors: [
        { field: "contactId", code: "required", message: "A contact is required" },
        { field: "title", code: "required", message: "A deal title is required" },
      ],
    });
  });

  it.each([
    [Number.NaN, "finite"],
    [Number.POSITIVE_INFINITY, "finite"],
    [-0.01, "non_negative"],
  ] as const)("rejects invalid amount %s with code %s", (amount, code) => {
    const validation = validateDeal({
      contactId: "contact-1",
      title: "Renewal",
      amount,
      currency: "USD",
    });

    expect(validation).toMatchObject({
      success: false,
      errors: [{ field: "amount", code }],
    });
  });

  it.each(["US", "USDD", "12A", "U$D"])("rejects invalid currency code %s", (currency) => {
    const validation = validateDeal({
      contactId: "contact-1",
      title: "Renewal",
      amount: 100,
      currency,
    });

    expect(validation).toMatchObject({
      success: false,
      errors: [{ field: "currency", code: "format" }],
    });
  });
});


describe("validateDealChanges", () => {
  it("normalizes only the fields present in an update", () => {
    expect(validateDealChanges({ title: " Renewal ", currency: "kwd" })).toEqual({
      success: true,
      value: { title: "Renewal", currency: "KWD" },
    });
  });

  it("returns structured errors for invalid supplied fields", () => {
    expect(validateDealChanges({ contactId: " ", amount: -1 })).toEqual({
      success: false,
      errors: [
        { field: "contactId", code: "required", message: "A contact is required" },
        { field: "amount", code: "non_negative", message: "Amount cannot be negative" },
      ],
    });
  });
});
describe("stage semantics", () => {
  it("uses stage_type rather than a stage display name", () => {
    const misleadingStage = {
      id: "stage-1",
      name: "Won",
      stage_type: "open" as const,
    };

    expect(isOpenStage(misleadingStage)).toBe(true);
    expect(isWonStage(misleadingStage)).toBe(false);
    expect(isLostStage(misleadingStage)).toBe(false);
    expect(dealStatusForStage(misleadingStage)).toBe("open");
  });

  it.each([
    [stages.open, "open"],
    [stages.won, "won"],
    [stages.lost, "lost"],
  ] as const)("derives $expectedStatus status from stage_type", (stage, expectedStatus) => {
    expect(dealStatusForStage(stage)).toBe(expectedStatus);
  });
});

describe("deal ordering", () => {
  it("sorts by position and uses id as the deterministic tie-breaker", () => {
    const unordered = [
      deal("deal-c", "stage-1", 2),
      deal("deal-b", "stage-1", 0),
      deal("deal-a", "stage-1", 0),
    ];

    expect(sortDealsByPosition(unordered).map(({ id }) => id)).toEqual([
      "deal-a",
      "deal-b",
      "deal-c",
    ]);
    expect(unordered.map(({ id }) => id)).toEqual(["deal-c", "deal-b", "deal-a"]);
  });

  it("groups each stage in position order without mutating the input", () => {
    const unordered = [
      deal("won-2", "stage-won", 1, "won"),
      deal("open-2", "stage-open", 1),
      deal("won-1", "stage-won", 0, "won"),
      deal("open-1", "stage-open", 0),
    ];

    const grouped = groupDealsByStage(unordered);

    expect(grouped["stage-open"].map(({ id }) => id)).toEqual(["open-1", "open-2"]);
    expect(grouped["stage-won"].map(({ id }) => id)).toEqual(["won-1", "won-2"]);
    expect(unordered.map(({ id }) => id)).toEqual([
      "won-2",
      "open-2",
      "won-1",
      "open-1",
    ]);
  });
});

describe("applyOptimisticDealMove", () => {
  it("renumbers a same-stage move using zero-based positions", () => {
    const moved = applyOptimisticDealMove(
      [
        deal("deal-a", "stage-open", 0),
        deal("deal-b", "stage-open", 1),
        deal("deal-c", "stage-open", 2),
      ],
      {
        dealId: "deal-a",
        sourceStageId: "stage-open",
        destinationStage: stages.open,
        destinationIndex: 2,
      },
    );

    expect(groupDealsByStage(moved)["stage-open"]).toEqual([
      deal("deal-b", "stage-open", 0),
      deal("deal-c", "stage-open", 1),
      deal("deal-a", "stage-open", 2),
    ]);
  });

  it("renumbers both stages and derives status for a cross-stage move", () => {
    const moved = applyOptimisticDealMove(
      [
        deal("open-a", "stage-open", 0),
        deal("open-b", "stage-open", 1),
        deal("won-a", "stage-won", 0, "won"),
        deal("won-b", "stage-won", 1, "won"),
      ],
      {
        dealId: "open-b",
        sourceStageId: "stage-open",
        destinationStage: stages.won,
        destinationIndex: 1,
      },
    );

    expect(groupDealsByStage(moved)["stage-open"]).toEqual([
      deal("open-a", "stage-open", 0),
    ]);
    expect(groupDealsByStage(moved)["stage-won"]).toEqual([
      deal("won-a", "stage-won", 0, "won"),
      deal("open-b", "stage-won", 1, "won"),
      deal("won-b", "stage-won", 2, "won"),
    ]);
  });

  it("clamps an index beyond the destination length to the end", () => {
    const moved = applyOptimisticDealMove(
      [
        deal("open-a", "stage-open", 0),
        deal("lost-a", "stage-lost", 0, "lost"),
      ],
      {
        dealId: "open-a",
        sourceStageId: "stage-open",
        destinationStage: stages.lost,
        destinationIndex: 99,
      },
    );

    expect(groupDealsByStage(moved)["stage-lost"]).toEqual([
      deal("lost-a", "stage-lost", 0, "lost"),
      deal("open-a", "stage-lost", 1, "lost"),
    ]);
  });

  it("returns an unchanged copy when the deal is not in the stated source stage", () => {
    const original = [deal("deal-a", "stage-open", 0)];
    const moved = applyOptimisticDealMove(original, {
      dealId: "deal-a",
      sourceStageId: "stage-won",
      destinationStage: stages.lost,
      destinationIndex: 0,
    });

    expect(moved).toEqual(original);
    expect(moved).not.toBe(original);
  });
});

