import { Link } from "react-router-dom";
import { 
  CheckCircle2, 
  Circle, 
  ExternalLink, 
  Link as LinkIcon,
  Download,
  FileJson,
  FileText
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChecklistItem, CategoryInfo } from "./types";

interface ChecklistSectionProps {
  items: ChecklistItem[];
  categoryInfo: Record<string, CategoryInfo>;
  completedItems: Set<string>;
  onToggle: (id: string) => void;
  platformName: string;
}

export function ChecklistSection({ 
  items, 
  categoryInfo, 
  completedItems, 
  onToggle, 
  platformName 
}: ChecklistSectionProps) {
  const requiredItems = items.filter(item => item.required);
  const completedRequired = requiredItems.filter(item => completedItems.has(item.id)).length;
  const progressPercent = requiredItems.length > 0 ? (completedRequired / requiredItems.length) * 100 : 0;

  const groupedItems = items.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, ChecklistItem[]>);

  const exportAsJSON = () => {
    const exportData = {
      platform: platformName,
      exportDate: new Date().toISOString(),
      progress: {
        completed: completedRequired,
        total: requiredItems.length,
        percentage: progressPercent.toFixed(1),
      },
      items: items.map(item => ({
        ...item,
        completed: completedItems.has(item.id),
      })),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${platformName.toLowerCase()}-verification-checklist-${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Checklist exported as JSON");
  };

  const exportAsPDF = () => {
    const completedCount = items.filter(item => completedItems.has(item.id)).length;
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${platformName} OAuth Verification Checklist</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px; }
          h1 { color: #1a1a1a; border-bottom: 2px solid #e5e5e5; padding-bottom: 10px; }
          h2 { color: #333; margin-top: 30px; }
          .progress { background: #f0f0f0; border-radius: 10px; height: 20px; margin: 20px 0; }
          .progress-bar { background: #22c55e; height: 100%; border-radius: 10px; }
          .item { padding: 10px 0; border-bottom: 1px solid #eee; }
          .item-title { font-weight: bold; }
          .item-completed { color: #22c55e; }
          .item-pending { color: #f59e0b; }
          .required { color: #ef4444; font-size: 12px; margin-left: 5px; }
          .description { color: #666; font-size: 14px; margin-top: 5px; }
          .meta { color: #888; font-size: 12px; margin-top: 20px; }
          .category { background: #f5f5f5; padding: 15px; margin: 20px 0; border-radius: 8px; }
          .checkbox { display: inline-block; width: 16px; height: 16px; border: 2px solid #ccc; border-radius: 3px; margin-right: 8px; vertical-align: middle; }
          .checkbox.checked { background: #22c55e; border-color: #22c55e; }
        </style>
      </head>
      <body>
        <h1>${platformName} OAuth Verification Checklist</h1>
        <div class="progress">
          <div class="progress-bar" style="width: ${progressPercent}%"></div>
        </div>
        <p><strong>Progress:</strong> ${completedCount}/${items.length} items completed (${progressPercent.toFixed(1)}%)</p>
        <p><strong>Required items:</strong> ${completedRequired}/${requiredItems.length}</p>
        
        ${Object.entries(groupedItems).map(([category, categoryItems]) => {
          const info = categoryInfo[category];
          return `
            <div class="category">
              <h2>${info?.label || category}</h2>
              ${categoryItems.map(item => `
                <div class="item">
                  <span class="checkbox ${completedItems.has(item.id) ? "checked" : ""}"></span>
                  <span class="item-title ${completedItems.has(item.id) ? "item-completed" : "item-pending"}">
                    ${item.title}
                  </span>
                  ${item.required ? '<span class="required">(Required)</span>' : ""}
                  <div class="description">${item.description}</div>
                  ${item.link ? `<div class="description">Reference: ${item.link}</div>` : ""}
                </div>
              `).join("")}
            </div>
          `;
        }).join("")}
        
        <div class="meta">
          <p>Exported on: ${new Date().toLocaleString()}</p>
          <p>This document serves as compliance documentation for ${platformName} OAuth integration.</p>
        </div>
      </body>
      </html>
    `;

    const printWindow = window.open("", "_blank");
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.onload = () => {
        printWindow.print();
      };
      toast.success("PDF print dialog opened");
    } else {
      toast.error("Please allow pop-ups to export PDF");
    }
  };

  return (
    <div className="space-y-6">
      {/* Progress Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>Verification Progress</span>
            <div className="flex items-center gap-2">
              <Badge variant={progressPercent === 100 ? "default" : "secondary"}>
                {completedRequired} / {requiredItems.length} Required
              </Badge>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Download className="h-4 w-4" />
                    Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={exportAsJSON} className="gap-2 cursor-pointer">
                    <FileJson className="h-4 w-4" />
                    Export as JSON
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={exportAsPDF} className="gap-2 cursor-pointer">
                    <FileText className="h-4 w-4" />
                    Export as PDF
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Progress value={progressPercent} className="h-3" />
          <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              {completedRequired} completed
            </span>
            <span className="flex items-center gap-1">
              <Circle className="h-4 w-4" />
              {requiredItems.length - completedRequired} remaining
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Category Cards */}
      <div className="space-y-4">
        {Object.entries(groupedItems).map(([category, categoryItems]) => {
          const info = categoryInfo[category];
          if (!info || categoryItems.length === 0) return null;
          const completedInCategory = categoryItems.filter(item => completedItems.has(item.id)).length;
          
          return (
            <Card key={category}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span className={`flex items-center gap-2 ${info.color}`}>
                    <info.icon className="h-5 w-5" />
                    {info.label}
                  </span>
                  <Badge variant="outline">
                    {completedInCategory} / {categoryItems.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {categoryItems.map((item) => {
                    const isCompleted = completedItems.has(item.id);
                    return (
                      <div 
                        key={item.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer hover:bg-muted/50 ${
                          isCompleted ? "bg-muted/30 border-green-500/30" : ""
                        }`}
                        onClick={() => onToggle(item.id)}
                      >
                        <div className="mt-0.5 shrink-0">
                          {isCompleted ? (
                            <CheckCircle2 className="h-5 w-5 text-green-500" />
                          ) : (
                            <Circle className="h-5 w-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`font-medium break-words min-w-0 ${isCompleted ? "line-through text-muted-foreground" : ""}`}>
                              {item.title}
                            </span>
                            {item.required && (
                              <Badge variant="destructive" className="text-xs">Required</Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground mt-1 break-words">
                            {item.description}
                          </p>
                          {(item.link || item.internalLink) && (
                            <div className="mt-2">
                              {item.internalLink ? (
                                <Link 
                                  to={item.internalLink}
                                  className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  View Page
                                  <LinkIcon className="h-3 w-3" />
                                </Link>
                              ) : (
                                <a 
                                  href={item.link}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  Reference Link
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
