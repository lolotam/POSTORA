import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  useMediaOperationsHistory,
  useDeleteMediaOperations,
  useClearAllMediaOperations,
  getOperationTypeLabel,
  OperationType,
  OperationStatus,
  MediaOperation,
} from "@/hooks/useMediaOperationsHistory";
import { Json } from "@/integrations/supabase/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Loader2,
  Trash2,
  ExternalLink,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Scissors,
  Maximize2,
  Crop,
  Move,
  Palette,
  Archive,
  Edit3,
  Layers,
  Wand2,
  RefreshCw,
  File,
  Image,
  Upload,
  Trash,
  FolderPlus,
  FolderMinus,
  Pencil,
  FolderInput,
  Download,
  ChevronDown,
  ChevronRight,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";



function getOperationIcon(type: OperationType) {
  const iconProps = { className: "w-4 h-4" };
  switch (type) {
    case "background_removal":
      return <Scissors {...iconProps} />;
    case "upscale":
      return <Maximize2 {...iconProps} />;
    case "crop":
      return <Crop {...iconProps} />;
    case "resize":
      return <Move {...iconProps} />;
    case "filter":
      return <Palette {...iconProps} />;
    case "compress":
      return <Archive {...iconProps} />;
    case "batch_rename":
      return <Edit3 {...iconProps} />;
    case "batch_tools":
      return <Layers {...iconProps} />;
    case "image_edit":
      return <Wand2 {...iconProps} />;
    case "replace_file":
      return <RefreshCw {...iconProps} />;
    case "upload":
      return <Upload {...iconProps} />;
    case "delete_file":
      return <Trash2 {...iconProps} />;
    case "delete_bulk":
      return <Trash {...iconProps} />;
    case "create_folder":
      return <FolderPlus {...iconProps} />;
    case "delete_folder":
      return <FolderMinus {...iconProps} />;
    case "rename_file":
    case "rename_folder":
      return <Pencil {...iconProps} />;
    case "move_file":
      return <FolderInput {...iconProps} />;
    case "download":
      return <Download {...iconProps} />;
    default:
      return <File {...iconProps} />;
  }
}

function getStatusBadge(status: OperationStatus, t: (key: string, fallback: string) => string) {
  switch (status) {
    case "completed":
      return (
        <Badge className="bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          {t("common:status.completed", "Completed")}
        </Badge>
      );
    case "processing":
      return (
        <Badge className="bg-blue-500/10 text-blue-500 hover:bg-blue-500/20">
          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          {t("common:status.processing", "Processing")}
        </Badge>
      );
    case "failed":
      return (
        <Badge className="bg-destructive/10 text-destructive hover:bg-destructive/20">
          <XCircle className="w-3 h-3 mr-1" />
          {t("common:status.failed", "Failed")}
        </Badge>
      );
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function formatDuration(ms: number | null): string {
  if (!ms) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function OperationDetails({ details }: { details: Json }) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return <span className="text-muted-foreground">-</span>;
  }

  const detailsObj = details as Record<string, unknown>;
  const items: string[] = [];

  // Image processing details
  if (detailsObj.scale) items.push(`Scale: ${detailsObj.scale}x`);
  if (detailsObj.platform) items.push(`Platform: ${detailsObj.platform}`);
  if (detailsObj.width && detailsObj.height)
    items.push(`Size: ${detailsObj.width}x${detailsObj.height}`);
  if (detailsObj.quality) items.push(`Quality: ${detailsObj.quality}`);
  if (detailsObj.format) items.push(`Format: ${detailsObj.format}`);
  if (detailsObj.edgeMode) items.push(`Edge: ${detailsObj.edgeMode}`);
  if (detailsObj.filters) {
    const filters = detailsObj.filters as string[];
    items.push(`Filters: ${filters.join(", ")}`);
  }
  if (detailsObj.count) items.push(`Count: ${detailsObj.count}`);
  if (detailsObj.features) {
    const features = detailsObj.features as string[];
    items.push(`Features: ${features.join(", ")}`);
  }
  
  // File/folder operations
  if (detailsObj.fileType) items.push(`Type: ${detailsObj.fileType}`);
  if (detailsObj.fileSize) {
    const size = detailsObj.fileSize as number;
    const sizeStr = size < 1024 * 1024 
      ? `${(size / 1024).toFixed(1)} KB` 
      : `${(size / (1024 * 1024)).toFixed(1)} MB`;
    items.push(`Size: ${sizeStr}`);
  }
  if (detailsObj.folder) items.push(`Folder: ${detailsObj.folder}`);
  if (detailsObj.folderName) items.push(`Name: ${detailsObj.folderName}`);
  if (detailsObj.newName) items.push(`New: ${detailsObj.newName}`);
  if (detailsObj.oldName) items.push(`Old: ${detailsObj.oldName}`);
  if (detailsObj.destination) items.push(`To: ${detailsObj.destination}`);
  if (detailsObj.filesCount) items.push(`Files: ${detailsObj.filesCount}`);

  if (items.length === 0) {
    const jsonStr = JSON.stringify(details);
    if (jsonStr === '{}') return <span className="text-muted-foreground">-</span>;
    return (
      <span className="text-muted-foreground text-xs">
        {jsonStr.slice(0, 50)}{jsonStr.length > 50 ? '...' : ''}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item, i) => (
        <Badge key={i} variant="outline" className="text-xs">
          {item}
        </Badge>
      ))}
    </div>
  );
}

// Full details panel component
function OperationFullDetails({ operation }: { operation: MediaOperation }) {
  const { t } = useTranslation("history");
  const details = operation.operation_details as Record<string, unknown> | null;
  
  return (
    <div className="bg-muted/50 rounded-lg p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Basic Info */}
        <div className="space-y-2">
          <h4 className="font-medium text-sm text-muted-foreground">{t("mediaOps.basicInfo", "Basic Info")}</h4>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("mediaOps.table.operation", "Operation")}:</span>
              <span className="font-medium">{getOperationTypeLabel(operation.operation_type)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("table.status", "Status")}:</span>
              <span className={cn(
                "font-medium",
                operation.status === "completed" && "text-emerald-500",
                operation.status === "failed" && "text-destructive",
                operation.status === "processing" && "text-blue-500"
              )}>
                {operation.status === "completed"
                  ? t("common:status.completed", "Completed")
                  : operation.status === "failed"
                  ? t("common:status.failed", "Failed")
                  : operation.status === "processing"
                  ? t("common:status.processing", "Processing")
                  : operation.status}
              </span>
            </div>
            {operation.file_name && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("mediaOps.fileLabel", "File:")}</span>
                <span className="font-medium truncate max-w-[200px]">{operation.file_name}</span>
              </div>
            )}
            {operation.duration_ms && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("mediaOps.durationLabel", "Duration:")}</span>
                <span className="font-medium">{formatDuration(operation.duration_ms)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Timestamps */}
        <div className="space-y-2">
          <h4 className="font-medium text-sm text-muted-foreground">{t("mediaOps.timestamps", "Timestamps")}</h4>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("mediaOps.started", "Started:")}</span>
              <span className="font-medium">{format(new Date(operation.created_at), "PPpp")}</span>
            </div>
            {operation.completed_at && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("mediaOps.completed", "Completed:")}</span>
                <span className="font-medium">{format(new Date(operation.completed_at), "PPpp")}</span>
              </div>
            )}
          </div>
        </div>

        {/* Operation Details */}
        {details && Object.keys(details).length > 0 && (
          <div className="space-y-2">
            <h4 className="font-medium text-sm text-muted-foreground">{t("mediaOps.operationDetails", "Operation Details")}</h4>
            <div className="space-y-1 text-sm">
              {Object.entries(details).map(([key, value]) => (
                <div key={key} className="flex justify-between">
                  <span className="text-muted-foreground capitalize">{key.replace(/_/g, ' ')}:</span>
                  <span className="font-medium truncate max-w-[200px]">
                    {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Error Message (for failed operations) */}
      {operation.status === "failed" && operation.error_message && (
        <div className="space-y-2">
          <h4 className="font-medium text-sm text-destructive flex items-center gap-2">
            <XCircle className="w-4 h-4" />
            {t("mediaOps.errorDetails", "Error Details")}
          </h4>
          <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
            {operation.error_message}
          </div>
        </div>
      )}

      {/* URLs */}
      {(operation.source_url || operation.result_url) && (
        <div className="space-y-2">
          <h4 className="font-medium text-sm text-muted-foreground">{t("mediaOps.urls", "URLs")}</h4>
          <div className="space-y-2 text-sm">
            {operation.source_url && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t("mediaOps.sourceLabel", "Source:")}</span>
                <a 
                  href={operation.source_url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:underline truncate max-w-[300px] flex items-center gap-1"
                >
                  {operation.source_url.split('/').pop()}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
            {operation.result_url && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t("mediaOps.resultLabel", "Result:")}</span>
                <a 
                  href={operation.result_url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:underline truncate max-w-[300px] flex items-center gap-1"
                >
                  {operation.result_url.split('/').pop()}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function MediaOperationsHistory() {
  const { t } = useTranslation("history");
  const [operationTypeFilter, setOperationTypeFilter] = useState<
    OperationType | "all"
  >("all");
  const [statusFilter, setStatusFilter] = useState<OperationStatus | "all">(
    "all"
  );
  const [selectedOperations, setSelectedOperations] = useState<Set<string>>(
    new Set()
  );
  const [expandedOperations, setExpandedOperations] = useState<Set<string>>(
    new Set()
  );
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [clearAllDialogOpen, setClearAllDialogOpen] = useState(false);

  const { data: operations = [], isLoading } = useMediaOperationsHistory({
    operationType: operationTypeFilter,
    status: statusFilter,
  });

  const deleteMutation = useDeleteMediaOperations();
  const clearAllMutation = useClearAllMediaOperations();

  const toggleSelection = (id: string) => {
    setSelectedOperations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedOperations(new Set(operations.map((op) => op.id)));
  };

  const deselectAll = () => {
    setSelectedOperations(new Set());
  };

  const toggleExpanded = (id: string) => {
    setExpandedOperations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleDelete = async () => {
    await deleteMutation.mutateAsync(Array.from(selectedOperations));
    setSelectedOperations(new Set());
    setDeleteDialogOpen(false);
  };

  const handleClearAll = async () => {
    await clearAllMutation.mutateAsync();
    setSelectedOperations(new Set());
    setClearAllDialogOpen(false);
  };

  const operationTypeOptions: { value: OperationType | "all"; label: string }[] = [
    { value: "all", label: t("mediaOps.allOperations", "All Operations") },
    { value: "upload", label: t("mediaOps.upload", "Upload") },
    { value: "delete_file", label: t("mediaOps.deleteFile", "Delete File") },
    { value: "delete_bulk", label: t("mediaOps.bulkDelete", "Bulk Delete") },
    { value: "create_folder", label: t("mediaOps.createFolder", "Create Folder") },
    { value: "delete_folder", label: t("mediaOps.deleteFolder", "Delete Folder") },
    { value: "rename_file", label: t("mediaOps.renameFile", "Rename File") },
    { value: "rename_folder", label: t("mediaOps.renameFolder", "Rename Folder") },
    { value: "move_file", label: t("mediaOps.moveFile", "Move File") },
    { value: "download", label: t("mediaOps.download", "Download") },
    { value: "background_removal", label: t("mediaOps.backgroundRemoval", "Background Removal") },
    { value: "upscale", label: t("mediaOps.upscale", "Upscale") },
    { value: "crop", label: t("mediaOps.crop", "Crop") },
    { value: "resize", label: t("mediaOps.resize", "Resize") },
    { value: "filter", label: t("mediaOps.filters", "Filters") },
    { value: "compress", label: t("mediaOps.compress", "Compress") },
    { value: "batch_rename", label: t("mediaOps.batchRename", "Batch Rename") },
    { value: "batch_tools", label: t("mediaOps.batchTools", "Batch Tools") },
    { value: "image_edit", label: t("mediaOps.imageEdit", "Image Edit") },
    { value: "replace_file", label: t("mediaOps.replaceFile", "Replace File") },
  ];

  const statusOptions: { value: OperationStatus | "all"; label: string }[] = [
    { value: "all", label: t("mediaOps.allStatus", "All Status") },
    { value: "completed", label: t("common:status.completed", "Completed") },
    { value: "processing", label: t("common:status.processing", "Processing") },
    { value: "failed", label: t("common:status.failed", "Failed") },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <Select
          value={operationTypeFilter}
          onValueChange={(v) =>
            setOperationTypeFilter(v as OperationType | "all")
          }
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder={t("mediaOps.allOperations", "All Operations")} />
          </SelectTrigger>
          <SelectContent>
            {operationTypeOptions.map((type) => (
              <SelectItem key={type.value} value={type.value}>
                {type.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as OperationStatus | "all")}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder={t("mediaOps.allStatus", "All Status")} />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((status) => (
              <SelectItem key={status.value} value={status.value}>
                {status.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1" />

        {selectedOperations.size > 0 && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            {t("mediaOps.deleteCount", "Delete ({{count}})", { count: selectedOperations.size })}
          </Button>
        )}

        {operations.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setClearAllDialogOpen(true)}
          >
            {t("mediaOps.clearAll", "Clear All")}
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold">{operations.length}</div>
          <div className="text-sm text-muted-foreground">{t("mediaOps.totalOperations", "Total Operations")}</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold text-emerald-500">
            {operations.filter((op) => op.status === "completed").length}
          </div>
          <div className="text-sm text-muted-foreground">{t("common:status.completed", "Completed")}</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold text-blue-500">
            {operations.filter((op) => op.status === "processing").length}
          </div>
          <div className="text-sm text-muted-foreground">{t("common:status.processing", "Processing")}</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold text-destructive">
            {operations.filter((op) => op.status === "failed").length}
          </div>
          <div className="text-sm text-muted-foreground">{t("common:status.failed", "Failed")}</div>
        </div>
      </div>

      {/* Table */}
      {operations.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-16 h-16 rounded-full bg-secondary mx-auto flex items-center justify-center mb-4">
            <Image className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-2">{t("mediaOps.noOperations", "No operations found")}</h3>
          <p className="text-muted-foreground">
            {t("mediaOps.noOperationsDesc", "Your media operation history will appear here")}
          </p>
        </div>
      ) : (
        <ScrollArea className="w-full">
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      checked={
                        selectedOperations.size === operations.length &&
                        operations.length > 0
                      }
                      onCheckedChange={(checked) =>
                        checked ? selectAll() : deselectAll()
                      }
                    />
                  </TableHead>
                  <TableHead>{t("mediaOps.table.operation", "Operation")}</TableHead>
                  <TableHead>{t("mediaOps.table.file", "File")}</TableHead>
                  <TableHead>{t("table.status", "Status")}</TableHead>
                  <TableHead>{t("mediaOps.table.duration", "Duration")}</TableHead>
                  <TableHead>{t("mediaOps.table.date", "Date")}</TableHead>
                  <TableHead className="w-24 text-center">{t("table.actions", "Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {operations.map((op) => (
                  <Collapsible key={op.id} open={expandedOperations.has(op.id)} asChild>
                    <>
                      <TableRow className={cn(expandedOperations.has(op.id) && "border-b-0")}>
                        <TableCell>
                          <Checkbox
                            checked={selectedOperations.has(op.id)}
                            onCheckedChange={() => toggleSelection(op.id)}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div
                              className={cn(
                                "p-2 rounded-lg",
                                op.status === "completed"
                                  ? "bg-emerald-500/10 text-emerald-500"
                                  : op.status === "failed"
                                  ? "bg-destructive/10 text-destructive"
                                  : "bg-blue-500/10 text-blue-500"
                              )}
                            >
                              {getOperationIcon(op.operation_type)}
                            </div>
                            <span className="font-medium">
                              {getOperationTypeLabel(op.operation_type)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="max-w-[150px] truncate block">
                                  {op.file_name || "-"}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {op.file_name || "No file name"}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </TableCell>
                        <TableCell>{getStatusBadge(op.status, t)}</TableCell>
                        <TableCell>
                          <span className="text-muted-foreground">
                            {formatDuration(op.duration_ms)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-muted-foreground whitespace-nowrap">
                                  {formatDistanceToNow(new Date(op.created_at), {
                                    addSuffix: true,
                                  })}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {format(new Date(op.created_at), "PPpp")}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-center gap-1">
                            <CollapsibleTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleExpanded(op.id)}
                                className="h-8 px-2"
                              >
                                {expandedOperations.has(op.id) ? (
                                  <ChevronDown className="w-4 h-4 mr-1" />
                                ) : (
                                  <ChevronRight className="w-4 h-4 mr-1" />
                                )}
                                <Info className="w-4 h-4" />
                              </Button>
                            </CollapsibleTrigger>
                            {op.result_url && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                                      <a
                                        href={op.result_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        <ExternalLink className="w-4 h-4" />
                                      </a>
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t("mediaOps.viewResult", "View Result")}</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                            {op.status === "failed" && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <AlertCircle className="w-4 h-4 text-destructive" />
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-[300px]">
                                    {op.error_message || t("mediaOps.operationFailed", "Operation failed")}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      <CollapsibleContent asChild>
                        <tr>
                          <td colSpan={7} className="p-0">
                            <div className="px-4 pb-4">
                              <OperationFullDetails operation={op} />
                            </div>
                          </td>
                        </tr>
                      </CollapsibleContent>
                    </>
                  </Collapsible>
                ))}
              </TableBody>
            </Table>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("mediaOps.deleteTitle", "Delete Operations")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("mediaOps.deleteDesc", "Are you sure you want to delete {{count}} operation(s) from history? This action cannot be undone.", { count: selectedOperations.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              {t("common:delete", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear All Confirmation */}
      <AlertDialog open={clearAllDialogOpen} onOpenChange={setClearAllDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("mediaOps.clearAllTitle", "Clear All History")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("mediaOps.clearAllDesc", "Are you sure you want to clear all operation history? This action cannot be undone.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearAllMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              {t("mediaOps.clearAll", "Clear All")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
