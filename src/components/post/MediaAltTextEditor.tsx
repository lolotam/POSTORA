import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Image, FileText } from "lucide-react";
import { SavedSuggestionsInput } from "./settings/SavedSuggestionsInput";

interface MediaAltTextEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaSrc: string;
  currentAltText: string;
  onSave: (altText: string) => void;
}

export function MediaAltTextEditor({
  open,
  onOpenChange,
  mediaSrc,
  currentAltText,
  onSave,
}: MediaAltTextEditorProps) {
  const { t } = useTranslation("postmedia");
  const [altText, setAltText] = useState(currentAltText);

  const handleSave = () => {
    onSave(altText);
    onOpenChange(false);
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setAltText(currentAltText);
    }
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            {t("altText.title", "Add Alt Text")}
          </DialogTitle>
          <DialogDescription>
            {t("altText.description", "Alt text describes the image for screen readers and when images fail to load.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Image Preview */}
          <div className="relative rounded-lg overflow-hidden bg-muted aspect-video flex items-center justify-center">
            <img
              src={mediaSrc}
              alt={t("altText.previewAlt", "Preview")}
              className="max-h-48 w-auto object-contain"
            />
          </div>

          {/* Alt Text Input */}
          <div className="space-y-2">
            <Label htmlFor="alt-text">{t("altText.descriptionLabel", "Description")}</Label>
            <SavedSuggestionsInput
              fieldType="alt_text"
              isTextarea
              value={altText}
              onChange={setAltText}
              placeholder={t("altText.placeholder", "Describe what's in this image...")}
              maxLength={1000}
              rows={3}
            />
            <p className="text-xs text-muted-foreground text-right">
              {altText.length}/1000
            </p>
          </div>

          {/* Tips */}
          <div className="p-3 rounded-lg bg-muted/50 space-y-1">
            <p className="text-xs font-medium">{t("altText.tipsTitle", "Tips for good alt text:")}</p>
            <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
              <li>{t("altText.tip1", "Be specific and descriptive")}</li>
              <li>{t("altText.tip2", "Keep it concise (under 125 characters is ideal)")}</li>
              <li>{t("altText.tip3", "Don't start with \"Image of\" or \"Picture of\"")}</li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button onClick={handleSave}>{t("altText.saveBtn", "Save Alt Text")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
