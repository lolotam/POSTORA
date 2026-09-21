import { useDroppable } from "@dnd-kit/core";
import { Folder, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MediaFolder } from "../types";

interface DroppableFolderProps {
  folder: MediaFolder;
  onNavigate: (path: string) => void;
  onRename: (folder: MediaFolder) => void;
  onDelete: (folder: MediaFolder) => void;
}

export function DroppableFolder({
  folder,
  onNavigate,
  onRename,
  onDelete,
}: DroppableFolderProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-${folder.id}`,
    data: { type: "folder", folder },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group relative flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all",
        isOver
          ? "border-primary bg-primary/10"
          : "border-border hover:border-primary/50"
      )}
    >
      <button
        className="flex flex-col items-center gap-2 w-full"
        onClick={() => onNavigate(folder.full_path)}
      >
        <Folder
          className={cn(
            "w-12 h-12",
            isOver ? "text-primary" : "text-muted-foreground"
          )}
        />
        <span className="text-sm font-medium truncate w-full text-center">
          {folder.name}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="secondary"
            className="absolute top-2 end-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="bg-background">
          <DropdownMenuItem onClick={() => onRename(folder)}>
            <Pencil className="w-4 h-4 me-2" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => onDelete(folder)}
          >
            <Trash2 className="w-4 h-4 me-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
