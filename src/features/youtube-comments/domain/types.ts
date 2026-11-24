/**
 * One contract shared with the edge function: re-exported, never redefined.
 * (ARCHITECTURE.md §22, the same pattern as youtube-management / instagram-insights.)
 * The import targets `contractTypes.ts` — the import-free half of the
 * contract — so the browser never follows the Deno-only Zod dependency.
 */
export type {
  Stage4Reason,
  Stage4Capability,
  Stage4CapabilitiesPayload,
  Stage4VideoRow,
  Stage4VideoPagePayload,
  Stage4CommentRow,
  Stage4ThreadPagePayload,
  Stage4ReplyPagePayload,
  Stage4ReceiptPayload,
  Stage4OperationStatusPayload,
  Stage4BanConfirmationPayload,
} from "../../../../supabase/functions/comment-manager/stage4/contractTypes";
export { STAGE4_HOLD_FROM_PUBLISHED } from "../../../../supabase/functions/comment-manager/stage4/contractTypes";
