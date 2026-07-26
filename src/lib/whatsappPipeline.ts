export type DealStatus = "open" | "won" | "lost";

export interface DealValidationInput {
  contactId: string;
  title: string;
  amount: number;
  currency: string;
}

export type DealValidationField = keyof DealValidationInput;
export type DealValidationCode = "required" | "finite" | "non_negative" | "format";

export interface DealValidationIssue {
  field: DealValidationField;
  code: DealValidationCode;
  message: string;
}

export type DealValidationResult =
  | { success: true; value: DealValidationInput }
  | { success: false; errors: DealValidationIssue[] };
export type DealValidationChanges = Partial<DealValidationInput>;
export type DealChangesValidationResult =
  | { success: true; value: DealValidationChanges }
  | { success: false; errors: DealValidationIssue[] };

export class WhatsAppDealValidationError extends Error {
  readonly issues: DealValidationIssue[];

  constructor(issues: DealValidationIssue[]) {
    super(issues.map(({ message }) => message).join(". "));
    this.name = "WhatsAppDealValidationError";
    this.issues = issues;
  }
}

export interface StageSemantics {
  id: string;
  stage_type: DealStatus;
}

export interface PositionedDeal {
  id: string;
  stage_id: string;
  position: number;
  status: string;
}

export interface OptimisticDealMove {
  dealId: string;
  sourceStageId: string;
  destinationStage: StageSemantics;
  destinationIndex: number;
}

function contactIssues(contactId: string): DealValidationIssue[] {
  if (contactId.trim()) return [];
  return [{ field: "contactId", code: "required", message: "A contact is required" }];
}

function titleIssues(title: string): DealValidationIssue[] {
  if (title.trim()) return [];
  return [{ field: "title", code: "required", message: "A deal title is required" }];
}

function amountIssues(amount: number): DealValidationIssue[] {
  if (!Number.isFinite(amount)) {
    return [{ field: "amount", code: "finite", message: "Amount must be a finite number" }];
  }
  if (amount < 0) {
    return [{ field: "amount", code: "non_negative", message: "Amount cannot be negative" }];
  }
  return [];
}

function currencyIssues(currency: string): DealValidationIssue[] {
  if (/^[A-Za-z]{3}$/.test(currency.trim())) return [];
  return [{ field: "currency", code: "format", message: "Currency must be a 3-letter code" }];
}

export function validateDeal(input: DealValidationInput): DealValidationResult {
  const errors = [
    ...contactIssues(input.contactId),
    ...titleIssues(input.title),
    ...amountIssues(input.amount),
    ...currencyIssues(input.currency),
  ];
  if (errors.length > 0) return { success: false, errors };

  return {
    success: true,
    value: {
      contactId: input.contactId.trim(),
      title: input.title.trim(),
      amount: input.amount,
      currency: input.currency.trim().toUpperCase(),
    },
  };
}

export function validateDealChanges(
  changes: DealValidationChanges,
): DealChangesValidationResult {
  const errors = [
    ...(changes.contactId === undefined ? [] : contactIssues(changes.contactId)),
    ...(changes.title === undefined ? [] : titleIssues(changes.title)),
    ...(changes.amount === undefined ? [] : amountIssues(changes.amount)),
    ...(changes.currency === undefined ? [] : currencyIssues(changes.currency)),
  ];
  if (errors.length > 0) return { success: false, errors };

  const value: DealValidationChanges = {};
  if (changes.contactId !== undefined) value.contactId = changes.contactId.trim();
  if (changes.title !== undefined) value.title = changes.title.trim();
  if (changes.amount !== undefined) value.amount = changes.amount;
  if (changes.currency !== undefined) value.currency = changes.currency.trim().toUpperCase();
  return { success: true, value };
}
export function isWonStage(stage: StageSemantics): boolean {
  return stage.stage_type === "won";
}

export function isLostStage(stage: StageSemantics): boolean {
  return stage.stage_type === "lost";
}

export function isOpenStage(stage: StageSemantics): boolean {
  return stage.stage_type === "open";
}

export function dealStatusForStage(stage: StageSemantics): DealStatus {
  return stage.stage_type;
}

export function sortDealsByPosition<T extends PositionedDeal>(deals: readonly T[]): T[] {
  return [...deals].sort((left, right) =>
    left.position - right.position || left.id.localeCompare(right.id),
  );
}

export function groupDealsByStage<T extends PositionedDeal>(
  deals: readonly T[],
): Record<string, T[]> {
  const groupedDeals: Record<string, T[]> = {};
  deals.forEach((currentDeal) => {
    groupedDeals[currentDeal.stage_id] ??= [];
    groupedDeals[currentDeal.stage_id].push(currentDeal);
  });
  Object.keys(groupedDeals).forEach((stageId) => {
    groupedDeals[stageId] = sortDealsByPosition(groupedDeals[stageId]);
  });
  return groupedDeals;
}

function withPosition<T extends PositionedDeal>(deal: T, position: number): T {
  return Object.assign({}, deal, { position });
}

function movedDeal<T extends PositionedDeal>(deal: T, move: OptimisticDealMove): T {
  return Object.assign({}, deal, {
    stage_id: move.destinationStage.id,
    position: move.destinationIndex,
    status: dealStatusForStage(move.destinationStage),
  });
}

function replacementMap<T extends PositionedDeal>(
  sourceDeals: readonly T[],
  destinationDeals: readonly T[],
): Map<string, T> {
  const replacements = new Map<string, T>();
  sourceDeals.forEach((currentDeal, index) => {
    replacements.set(currentDeal.id, withPosition(currentDeal, index));
  });
  destinationDeals.forEach((currentDeal, index) => {
    replacements.set(currentDeal.id, withPosition(currentDeal, index));
  });
  return replacements;
}

function dealsForStage<T extends PositionedDeal>(deals: readonly T[], stageId: string): T[] {
  return sortDealsByPosition(deals.filter(({ stage_id }) => stage_id === stageId));
}

function destinationOrder<T extends PositionedDeal>(
  destinationDeals: readonly T[],
  currentDeal: T,
  move: OptimisticDealMove,
): T[] {
  const destinationIndex = Math.min(
    Math.max(move.destinationIndex, 0),
    destinationDeals.length,
  );
  const orderedDeals = [...destinationDeals];
  orderedDeals.splice(destinationIndex, 0, movedDeal(currentDeal, {
    ...move,
    destinationIndex,
  }));
  return orderedDeals;
}

export function applyOptimisticDealMove<T extends PositionedDeal>(
  deals: readonly T[],
  move: OptimisticDealMove,
): T[] {
  const currentDeal = deals.find(({ id }) => id === move.dealId);
  if (!currentDeal || currentDeal.stage_id !== move.sourceStageId) return [...deals];

  const remainingDeals = deals.filter(({ id }) => id !== move.dealId);
  const sourceDeals = dealsForStage(remainingDeals, move.sourceStageId);
  const destinationBase = move.sourceStageId === move.destinationStage.id
    ? sourceDeals
    : dealsForStage(remainingDeals, move.destinationStage.id);
  const destinationDeals = destinationOrder(destinationBase, currentDeal, move);
  const replacements = replacementMap(
    move.sourceStageId === move.destinationStage.id ? [] : sourceDeals,
    destinationDeals,
  );
  return deals.map((existingDeal) => replacements.get(existingDeal.id) ?? existingDeal);
}


