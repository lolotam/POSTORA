/**
 * The public surface of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The ONE place another feature may import from. Everything a caller
 *   needs - the report contract, the typed errors, the pure formatters,
 *   the handle rules, the port and the three lifecycles - is exported
 *   here, and nothing else is.
 *
 * WHY THE ADAPTER IS NOT EXPORTED
 *
 *   The infrastructure adapter is wired by the feature's own composition
 *   roots (`CompetitorTrackingScreen` and `TrackCompetitorControl`). A
 *   cross-feature import of the adapter would let a caller bypass those
 *   roots, so the adapter stays internal to the feature.
 *
 * WHY ONLY THREE UI PIECES ARE EXPORTED
 *
 *   The screen, the Track control and the source badge are the pieces
 *   another feature composes. The list, the sheet, the dialog and the
 *   hooks are the screen's own internals, and exporting them would make
 *   them somebody else's API to keep.
 */

export * from "./domain/contracts";
export * from "./domain/errors";
export * from "./domain/formatters";
export * from "./domain/handle";
export * from "./application/ports";
export * from "./application/trackCompetitor";
export * from "./application/removeCompetitor";
export * from "./application/reactivateCompetitor";
export * from "./ui/CompetitorTrackingScreen";
export * from "./ui/TrackCompetitorControl";
export * from "./ui/CompetitorSourceBadge";
