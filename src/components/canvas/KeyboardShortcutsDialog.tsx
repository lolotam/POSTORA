import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Keyboard } from "lucide-react";
import { Icon3D } from "@/components/fx/Icon3D";

const shortcuts = [
  { keys: ["Ctrl", "S"], description: "Save workflow" },
  { keys: ["Ctrl", "Z"], description: "Undo" },
  { keys: ["Ctrl", "Shift", "Z"], description: "Redo" },
  { keys: ["Delete"], description: "Delete selected nodes" },
  { keys: ["Backspace"], description: "Delete selected nodes" },
  { keys: ["Space", "Drag"], description: "Pan canvas" },
  { keys: ["Scroll"], description: "Zoom in/out" },
];

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsDialog({ open, onOpenChange }: KeyboardShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm bg-card ring-1 ring-white/10 border-0">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Icon3D icon={Keyboard} variant="sky" size="sm" />
            <DialogTitle className="text-foreground">
              Keyboard Shortcuts
            </DialogTitle>
          </div>
        </DialogHeader>
        <div className="space-y-2">
          {shortcuts.map((s, i) => (
            <div
              key={i}
              className="flex items-center justify-between p-2.5 rounded-lg bg-white/[0.03] ring-1 ring-white/10 hover:bg-white/[0.06] transition-colors"
            >
              <span className="text-sm text-muted-foreground">{s.description}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((k, j) => (
                  <span key={j} className="inline-flex items-center">
                    {j > 0 && <span className="text-muted-foreground text-xs mx-0.5">+</span>}
                    <kbd className="px-2 py-1 bg-white/5 ring-1 ring-white/10 rounded text-xs font-mono">{k}</kbd>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
