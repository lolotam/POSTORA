import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { batchOriginalName, renameBatchFile, type BatchRenameFile } from "./batchRename";
import { Loader2, FileEdit, Hash, ArrowRight } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";

interface BatchRenameDialogProps {
  open: boolean;
  onClose: () => void;
  files: BatchRenameFile[];
  onRenameComplete?: () => void;
}

type NumberingStyle = "numeric" | "padded" | "alpha";

const NUMBERING_STYLES = {
  numeric: { label: "1, 2, 3...", example: "image-1, image-2, image-3" },
  padded: { label: "001, 002, 003...", example: "image-001, image-002, image-003" },
  alpha: { label: "a, b, c...", example: "image-a, image-b, image-c" },
};

function getNumberSuffix(index: number, style: NumberingStyle, padLength: number = 3): string {
  switch (style) {
    case "numeric":
      return String(index + 1);
    case "padded":
      return String(index + 1).padStart(padLength, "0");
    case "alpha": {
      // Convert to a, b, c... z, aa, ab, etc.
      let result = "";
      let n = index;
      do {
        result = String.fromCharCode(97 + (n % 26)) + result;
        n = Math.floor(n / 26) - 1;
      } while (n >= 0);
      return result;
    }
    default:
      return String(index + 1);
  }
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot !== -1 ? filename.slice(lastDot) : "";
}

function getBaseName(filePath: string): string {
  const filename = filePath.split("/").pop() || "";
  const lastDot = filename.lastIndexOf(".");
  return lastDot !== -1 ? filename.slice(0, lastDot) : filename;
}

export function BatchRenameDialog({
  open,
  onClose,
  files,
  onRenameComplete,
}: BatchRenameDialogProps) {
  const [baseName, setBaseName] = useState("image");
  const [separator, setSeparator] = useState("-");
  const [numberingStyle, setNumberingStyle] = useState<NumberingStyle>("padded");
  const [startNumber, setStartNumber] = useState(1);
  const [isRenaming, setIsRenaming] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const numberingLabels = {
    numeric: t("rename.numbering.numeric", "1, 2, 3..."),
    padded: t("rename.numbering.padded", "001, 002, 003..."),
    alpha: t("rename.numbering.alpha", "a, b, c..."),
  };

  // Reset state when dialog opens
  useEffect(() => {
    if (open && files.length > 0) {
      // Try to use the first file's base name as default
      const firstFileBaseName = getBaseName(batchOriginalName(files[0]));
      // Remove any existing numbering pattern
      const cleanName = firstFileBaseName.replace(/[-_]?\d+$/, "").replace(/[-_]?[a-z]$/, "");
      setBaseName(cleanName || "image");
      setStartNumber(1);
      setProgress({ current: 0, total: 0 });
    }
  }, [open, files]);

  const generateNewName = (index: number, originalName: string): string => {
    const ext = getExtension(originalName);
    const suffix = getNumberSuffix(index + startNumber - 1, numberingStyle);
    const actualSeparator = separator === "none" ? "" : separator;
    return `${baseName}${actualSeparator}${suffix}${ext}`;
  };

  const previewNames = files.slice(0, 5).map((file, index) => {
    const original = batchOriginalName(file);
    return {
      original,
      new: generateNewName(index, original),
    };
  });

  const handleBatchRename = async () => {
    if (files.length === 0) return;

    setIsRenaming(true);
    setProgress({ current: 0, total: files.length });

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const newName = generateNewName(i, batchOriginalName(file));

      try {
        await renameBatchFile(file, newName);
        successCount++;
      } catch (error) {
        console.error(`Failed to rename file ${file.id}:`, error);
        failCount++;
      }

      setProgress({ current: i + 1, total: files.length });
    }

    setIsRenaming(false);

    if (failCount === 0) {
      toast({
        title: t("toast.batchRenameComplete", "Batch rename complete"),
        description: t("toast.batchRenameOk", "Successfully renamed {{count}} files", { count: successCount }),
      });
    } else {
      toast({
        title: t("toast.batchRenameErrors", "Batch rename completed with errors"),
        description: t("toast.batchRenameErrorsDesc", "{{success}} succeeded, {{fail}} failed", { success: successCount, fail: failCount }),
        variant: "destructive",
      });
    }

    onRenameComplete?.();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileEdit className="w-5 h-5" />
            {t("rename.batchTitle", "Batch Rename")}
          </DialogTitle>
          <DialogDescription>
            {t("rename.batchSubtitle", "Rename {{count}} selected files with a pattern", { count: files.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Pattern Settings */}
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label>{t("rename.baseName", "Base Name")}</Label>
              <Input
                value={baseName}
                onChange={(e) => setBaseName(e.target.value)}
                placeholder="image"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("rename.separator", "Separator")}</Label>
                <Select value={separator} onValueChange={setSeparator}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="-">{t("rename.hyphen", "Hyphen (-)")}</SelectItem>
                    <SelectItem value="_">{t("rename.underscore", "Underscore (_)")}</SelectItem>
                    <SelectItem value="none">{t("rename.none", "None")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{t("rename.numberingStyle", "Numbering Style")}</Label>
                <Select
                  value={numberingStyle}
                  onValueChange={(v) => setNumberingStyle(v as NumberingStyle)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(NUMBERING_STYLES).map(([key]) => (
                      <SelectItem key={key} value={key}>
                        {numberingLabels[key as NumberingStyle]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("rename.startNumber", "Start Number")}</Label>
              <Input
                type="number"
                value={startNumber}
                onChange={(e) => setStartNumber(Math.max(1, Number(e.target.value)))}
                min={1}
              />
            </div>
          </div>

          {/* Preview */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Hash className="w-4 h-4" />
              {t("rename.preview", "Preview")}
            </Label>
            <ScrollArea className="h-[140px] rounded-md border p-3">
              <div className="space-y-2">
                {previewNames.map((item, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 text-sm font-mono"
                  >
                    <span className="text-muted-foreground truncate max-w-[140px]">
                      {item.original}
                    </span>
                    <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-primary truncate max-w-[140px]">
                      {item.new}
                    </span>
                  </div>
                ))}
                {files.length > 5 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {t("rename.moreFiles", "... and {{count}} more files", { count: files.length - 5 })}
                  </p>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Progress */}
          {isRenaming && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>{t("rename.renamingFiles", "Renaming files...")}</span>
                <span className="text-muted-foreground">
                  {progress.current} / {progress.total}
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{
                    width: `${(progress.current / progress.total) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isRenaming}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button
            onClick={handleBatchRename}
            disabled={isRenaming || !baseName.trim() || files.length === 0}
          >
            {isRenaming ? (
              <>
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
                {t("rename.renaming", "Renaming...")}
              </>
            ) : (
              <>
                <FileEdit className="w-4 h-4 me-2" />
                {t("rename.renameCount", "Rename {{count}} Files", { count: files.length })}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
