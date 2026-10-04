import { useDraggable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { MediaFile } from "../types";

interface DraggableMediaCardProps {
  file: MediaFile;
  children: React.ReactNode;
}

export function DraggableMediaCard({ file, children }: DraggableMediaCardProps) {
  const { attributes, listeners, setNodeRef, isDragging, transform } = useDraggable({
    id: file.id,
    data: { type: "file", file },
  });

  const style: React.CSSProperties = {
    opacity: isDragging ? 0.5 : 1,
    touchAction: "none",
    ...(transform
      ? {
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
          zIndex: 1000,
        }
      : {}),
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative group"
      data-dnd-dragging={isDragging || undefined}
      {...attributes}
      {...listeners}
    >
      <div className="absolute top-2 start-8 z-10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <div className="w-6 h-6 bg-background rounded flex items-center justify-center cursor-grab">
          <GripVertical className="w-4 h-4 text-muted-foreground" />
        </div>
      </div>
      {children}
    </div>
  );
}
