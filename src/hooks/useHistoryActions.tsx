import { usePostRetry } from "./history/usePostRetry";
import { usePostDelete } from "./history/usePostDelete";

// Re-export types for backward compatibility
export type { PostWithResults, PlatformResult } from "./history/historyUtils";

export function useHistoryActions() {
  const retry = usePostRetry();
  const del = usePostDelete();

  return {
    // Retry state
    retryingPostId: retry.retryingPostId,
    bulkRetrying: retry.bulkRetrying,
    bulkRetryProgress: retry.bulkRetryProgress,

    // Delete state
    deletePost: del.deletePost,
    setDeletePost: del.setDeletePost,
    isDeleting: del.isDeleting,

    // Bulk selection
    selectedPosts: del.selectedPosts,
    bulkDeleteDialogOpen: del.bulkDeleteDialogOpen,
    setBulkDeleteDialogOpen: del.setBulkDeleteDialogOpen,
    isBulkDeleting: del.isBulkDeleting,

    // Retry dialog
    retryDialogPost: retry.retryDialogPost,
    setRetryDialogPost: retry.setRetryDialogPost,
    retrySelectedAccountIds: retry.retrySelectedAccountIds,
    retryLoading: retry.retryLoading,

    // Retry media
    retryMediaDialogPost: retry.retryMediaDialogPost,
    setRetryMediaDialogPost: retry.setRetryMediaDialogPost,
    retryMediaFiles: retry.retryMediaFiles,
    setRetryMediaFiles: retry.setRetryMediaFiles,
    retryMediaUploading: retry.retryMediaUploading,
    retryMediaInputRef: retry.retryMediaInputRef,

    // Actions
    handleRetryFailed: retry.handleRetryFailed,
    handleRetrySinglePlatform: retry.handleRetrySinglePlatform,
    handleRetryWithAccounts: retry.handleRetryWithAccounts,
    handleRetryWithNewMedia: retry.handleRetryWithNewMedia,
    handleDeletePost: del.handleDeletePost,
    handleDeletePlatformPost: del.handleDeletePlatformPost,
    handleBulkRetry: retry.handleBulkRetry,
    handleBulkDelete: del.handleBulkDelete,
    togglePostSelection: del.togglePostSelection,
    selectAllPosts: del.selectAllPosts,
    deselectAllPosts: del.deselectAllPosts,
    openRetryMediaDialog: retry.openRetryMediaDialog,
    isTikTokMediaError: retry.isTikTokMediaError,
    toggleRetryAccountSelection: retry.toggleRetryAccountSelection,
  };
}
