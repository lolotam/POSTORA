import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import type { WhatsAppPipelineStage } from "@/hooks/useWhatsAppPipelines";

export interface PipelineSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stages: WhatsAppPipelineStage[];
}

/**
 * Stage configuration is owner/admin only. The caller is responsible for not
 * rendering the trigger for agents and viewers; this dialog states the semantics
 * so the meaning of a stage is never inferred from its display name.
 */
export function PipelineSettingsDialog({
  open,
  onOpenChange,
  stages,
}: PipelineSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pipeline stages</DialogTitle>
          <DialogDescription>
            A stage's outcome comes from its type, not its name, so renaming a stage never
            changes how deals are counted.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2">
          {stages.map((stage) => (
            <li
              key={stage.id}
              className="flex items-center justify-between rounded-md border p-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: stage.color ?? "#3b82f6" }}
                />
                <span className="text-sm font-medium">{stage.name}</span>
              </div>
              <Badge variant="outline">{stage.stage_type}</Badge>
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
