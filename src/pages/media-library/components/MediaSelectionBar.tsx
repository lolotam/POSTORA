import { useTranslation } from "react-i18next";
import { Send, Pencil, Wand2, Move, Download, Trash2, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MediaSelectionBarProps {
  selectedCount: number;
  totalCount: number;
  displayedCount: number;
  allSelectedAreImages: boolean;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onSendToPost: () => void;
  onBatchRename: () => void;
  onBatchImageTools: () => void;
  onMove: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onKeepForever: () => void;
  onAllowExpiry: () => void;
}

export function MediaSelectionBar({
  selectedCount,
  totalCount,
  displayedCount,
  allSelectedAreImages,
  onSelectAll,
  onDeselectAll,
  onSendToPost,
  onBatchRename,
  onBatchImageTools,
  onMove,
  onDownload,
  onDelete,
  onKeepForever,
  onAllowExpiry,
}: MediaSelectionBarProps) {
  const { t } = useTranslation("assets");
  if (totalCount === 0) return null;

  return (
    <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg flex-wrap">
      {selectedCount > 0 ? (
        <>
          <span className="text-sm font-medium">{selectedCount} selected</span>
          <div className="flex-1" />
          {selectedCount < totalCount && (
            <Button variant="outline" size="sm" onClick={onSelectAll}>
              Select All ({totalCount})
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onDeselectAll}>
            Deselect All
          </Button>
          <Button size="sm" onClick={onSendToPost}>
            <Send className="w-4 h-4 me-2" />
            Send to Post
          </Button>
          <Button variant="outline" size="sm" onClick={onBatchRename}>
            <Pencil className="w-4 h-4 me-2" />
            Batch Rename
          </Button>
          {allSelectedAreImages && (
            <Button variant="outline" size="sm" onClick={onBatchImageTools}>
              <Wand2 className="w-4 h-4 me-2" />
              Image Tools
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onMove}>
            <Move className="w-4 h-4 me-2" />
            Move
          </Button>
          <Button variant="outline" size="sm" onClick={onKeepForever}>
            <Pin className="w-4 h-4 me-2" />
            {t("retention.keepForever", "Keep forever")}
          </Button>
          <Button variant="outline" size="sm" onClick={onAllowExpiry}>
            {t("retention.allowExpiry", "Allow expiry")}
          </Button>
          <Button variant="secondary" size="sm" onClick={onDownload}>
            <Download className="w-4 h-4 me-2" />
            Download
          </Button>
          <Button variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 className="w-4 h-4 me-2" />
            Delete
          </Button>
        </>
      ) : (
        <>
          <span className="text-sm text-muted-foreground">
            {displayedCount === totalCount
              ? `${totalCount} files in this view`
              : `Showing ${displayedCount} of ${totalCount} files`}
          </span>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={onSelectAll}>
            Select All
          </Button>
        </>
      )}
    </div>
  );
}
