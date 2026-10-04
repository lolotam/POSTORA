import { useState } from "react";
import { Type, Image, Share2, ChevronLeft, ChevronRight, GripVertical, Wand2, Boxes } from "lucide-react";
import { cn } from "@/lib/utils";
import { NODE_TYPES, NODE_CATEGORIES, type NodeCategory } from "@/lib/canvas/nodeTypes";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Reveal } from "@/components/fx/Reveal";

interface NodeLibraryProps {
  onDragStart: (event: React.DragEvent, nodeType: string) => void;
}

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  Type,
  Image,
  Share2,
  Wand2,
};

export function NodeLibrary({ onDragStart }: NodeLibraryProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  if (isCollapsed) {
    return (
      <div className="absolute start-4 top-1/2 -translate-y-1/2 z-10">
        <div className="relative bg-card ring-1 ring-white/10 rounded-2xl shadow-2xl p-2 space-y-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-white/10" onClick={() => setIsCollapsed(false)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand Library</TooltipContent>
          </Tooltip>
          
          <div className="h-px bg-border" />
          
          {NODE_TYPES.map((node) => {
            const Icon = iconMap[node.icon] || Type;
            const categoryInfo = NODE_CATEGORIES[node.category];
            
            return (
              <Tooltip key={node.type}>
                <TooltipTrigger asChild>
                  <button
                    draggable
                    onDragStart={(e) => onDragStart(e, node.type)}
                    className={cn(
                      "w-10 h-10 rounded-xl flex items-center justify-center cursor-grab active:cursor-grabbing transition-all ring-1 ring-white/10",
                      categoryInfo.bgColor,
                      "hover:scale-110 hover:shadow-lg hover:-translate-y-0.5"
                    )}
                  >
                    <Icon className={cn("h-5 w-5", categoryInfo.color)} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <div>
                    <p className="font-medium">{node.label}</p>
                    <p className="text-xs text-muted-foreground">{node.description}</p>
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute start-4 top-4 bottom-4 z-10 w-[240px]">
      <div className="relative h-full">
        <div className="relative h-full bg-card ring-1 ring-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="p-3 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative h-7 w-7 rounded-lg ring-1 ring-white/30 shadow-md flex items-center justify-center shrink-0 bg-violet-500">
              <span aria-hidden className="pointer-events-none absolute inset-x-1 top-0.5 h-1/2 rounded-t-lg bg-gradient-to-b from-white/50 to-transparent" />
              <Boxes className="relative h-3.5 w-3.5 text-white drop-shadow" strokeWidth={2.4} />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-foreground">Node Library</h3>
              <p className="text-[10px] text-muted-foreground">Drag nodes to canvas</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 hover:bg-white/10" onClick={() => setIsCollapsed(true)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 p-3 space-y-4 overflow-y-auto">
          {(Object.keys(NODE_CATEGORIES) as NodeCategory[]).map((categoryKey, catIdx) => {
            const categoryNodes = NODE_TYPES.filter(n => n.category === categoryKey);
            if (categoryNodes.length === 0) return null;
            const categoryInfo = NODE_CATEGORIES[categoryKey];
            
            return (
              <Reveal key={categoryKey} delay={catIdx * 80} className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <div className={cn("h-1.5 w-1.5 rounded-full", categoryInfo.bgColor.replace('/10', ''))} 
                       style={{ backgroundColor: categoryInfo.hex }} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground">
                    {categoryInfo.label}
                  </span>
                </div>
                {categoryNodes.map((node) => {
                  const Icon = iconMap[node.icon] || Type;
                  return (
                    <div
                      key={node.type}
                      draggable
                      onDragStart={(e) => onDragStart(e, node.type)}
                      className={cn(
                        "group p-3 rounded-xl cursor-grab active:cursor-grabbing transition-all duration-300",
                        "ring-1 ring-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:ring-current hover:-translate-y-0.5 hover:shadow-lg",
                        categoryInfo.color
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground">
                          <GripVertical className="h-4 w-4" />
                        </div>
                        <div className={cn("p-2 rounded-lg ring-1 ring-white/10", categoryInfo.bgColor)}>
                          <Icon className={cn("h-5 w-5", categoryInfo.color)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm text-foreground">{node.label}</p>
                          <p className="text-[10px] text-muted-foreground truncate">{node.description}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </Reveal>
            );
          })}
        </div>

        <div className="p-3 border-t border-white/10">
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">
              Connect nodes to create your workflow
            </p>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
