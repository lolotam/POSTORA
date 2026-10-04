import { useState } from "react";
import { 
  Save, 
  Play, 
  Undo2, 
  Redo2, 
  ZoomIn, 
  ZoomOut, 
  Maximize2,
  Trash2,
  Keyboard,
  MoreHorizontal,
  ChevronLeft,
  FolderOpen,
  Check,
  Circle,
  Workflow,
  Home
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";

interface CanvasToolbarProps {
  workflowName: string;
  onWorkflowNameChange: (name: string) => void;
  onSave: () => void;
  onRun: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  onClear: () => void;
  onShowWorkflows: () => void;
  onShowShortcuts: () => void;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  nodeCount: number;
  isSaving?: boolean;
  isRunning?: boolean;
  hasUnsavedChanges?: boolean;
}

export function CanvasToolbar({
  workflowName,
  onWorkflowNameChange,
  onSave,
  onRun,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onFitView,
  onClear,
  onShowWorkflows,
  onShowShortcuts,
  canUndo,
  canRedo,
  zoom,
  nodeCount,
  isSaving = false,
  isRunning = false,
  hasUnsavedChanges = false,
}: CanvasToolbarProps) {
  const [isEditingName, setIsEditingName] = useState(false);

  return (
    <div className="relative h-14 bg-card flex items-center px-4 gap-3 ring-1 ring-white/10">
      {/* Gradient hairline underline */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-border"
      />
      {/* Back & Workflow Name */}
      <div className="flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-white/5" asChild>
              <Link to="/dashboard">
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back to Dashboard</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2.5 bg-white/5 ring-1 ring-white/10 hover:ring-violet-400/40 hover:bg-white/10 rounded-xl"
            >
              <Link to="/dashboard">
                <Home className="h-4 w-4" />
                <span className="hidden sm:inline">Home</span>
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Go to Dashboard</TooltipContent>
        </Tooltip>

        <div className="flex items-center gap-2">
          <div className="relative h-8 w-8 rounded-xl ring-1 ring-white/30 shadow-lg flex items-center justify-center bg-violet-500">
            <span aria-hidden className="pointer-events-none absolute inset-x-1 top-0.5 h-1/2 rounded-t-xl bg-gradient-to-b from-white/50 to-transparent" />
            <Workflow className="relative h-4 w-4 text-white drop-shadow" strokeWidth={2.4} />
          </div>
          <div className="flex items-center gap-2">
            {isEditingName ? (
              <Input
                value={workflowName}
                onChange={(e) => onWorkflowNameChange(e.target.value)}
                onBlur={() => setIsEditingName(false)}
                onKeyDown={(e) => { if (e.key === 'Enter') setIsEditingName(false); }}
                className="h-7 w-[180px] text-sm font-semibold"
                autoFocus
              />
            ) : (
              <button
                type="button"
                onClick={() => setIsEditingName(true)}
                title="Click to rename"
                className="font-semibold text-sm hover:opacity-80 transition-opacity text-foreground"
              >
                {workflowName}
              </button>
            )}
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-white/5 ring-1 ring-white/10 text-muted-foreground border-0">
              {nodeCount} nodes
            </Badge>
            {/* Save status pill */}
            <span className="inline-flex items-center gap-1 rounded-full bg-white/5 ring-1 ring-white/10 px-2 py-0.5">
              {isSaving ? (
                <Circle className="h-2 w-2 text-amber-500 fill-amber-500 animate-pulse" />
              ) : hasUnsavedChanges ? (
                <Circle className="h-2 w-2 text-amber-500 fill-amber-500" />
              ) : (
                <Check className="h-2.5 w-2.5 text-emerald-400" />
              )}
              <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                {isSaving ? "Saving" : hasUnsavedChanges ? "Unsaved" : "Saved"}
              </span>
            </span>
          </div>
        </div>
      </div>

      <Separator orientation="vertical" className="h-6 bg-white/10" />

      {/* Main Actions */}
      <div className="flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onShowWorkflows} className="h-8 gap-1.5 hover:bg-white/5">
              <FolderOpen className="h-4 w-4" />
              <span className="hidden sm:inline">Workflows</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>My Workflows</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onSave}
              disabled={isSaving}
              className="h-8 gap-1.5 bg-white/5 ring-1 ring-violet-400/30 hover:ring-violet-400/60 hover:bg-white/10 text-foreground"
            >
              <Save className={cn("h-4 w-4", isSaving && "animate-pulse")} />
              <span className="hidden sm:inline">Save</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Save workflow (Ctrl+S)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              onClick={onRun}
              disabled={isRunning || nodeCount === 0}
              className="h-8 gap-1.5 text-white shadow-lg hover:brightness-110 border-0 bg-neutral-900 dark:bg-neutral-800"
            >
              <Play className={cn("h-4 w-4", isRunning && "animate-pulse")} />
              <span className="hidden sm:inline">Run</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Execute workflow</TooltipContent>
        </Tooltip>
      </div>

      <Separator orientation="vertical" className="h-6 bg-white/10" />

      {/* History Controls */}
      <div className="flex items-center gap-0.5 bg-white/5 ring-1 ring-white/10 rounded-xl p-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onUndo} disabled={!canUndo} className="h-7 w-7 hover:bg-white/10">
              <Undo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onRedo} disabled={!canRedo} className="h-7 w-7 hover:bg-white/10">
              <Redo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo (Ctrl+Shift+Z)</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex-1" />

      {/* Zoom Controls */}
      <div className="flex items-center gap-0.5 bg-white/5 ring-1 ring-white/10 rounded-xl p-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onZoomOut} className="h-7 w-7 hover:bg-white/10">
              <ZoomOut className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <span className="text-xs w-12 text-center font-semibold text-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onZoomIn} className="h-7 w-7 hover:bg-white/10">
              <ZoomIn className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="h-4 mx-0.5 bg-white/10" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onFitView} className="h-7 w-7 hover:bg-white/10">
              <Maximize2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Fit view</TooltipContent>
        </Tooltip>
      </div>

      <Separator orientation="vertical" className="h-6 bg-white/10" />

      {/* More Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-white/5">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onClear} disabled={nodeCount === 0}>
            <Trash2 className="h-4 w-4 me-2 text-destructive" />
            Clear canvas
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onShowShortcuts}>
            <Keyboard className="h-4 w-4 me-2" />
            Keyboard shortcuts
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
