import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { ChevronDown } from "lucide-react";

interface FeatureFlagCategoryDropdownProps {
  currentCategory: string;
  categories: string[];
  onChange: (category: string) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  Media: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  AI: "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  Social: "bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30",
  UI: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  Notifications: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30",
  Debug: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
};

export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || "bg-secondary text-secondary-foreground border-border";
}

export function FeatureFlagCategoryDropdown({
  currentCategory,
  categories,
  onChange,
}: FeatureFlagCategoryDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors hover:opacity-80 ${getCategoryColor(currentCategory)}`}>
          {currentCategory}
          <ChevronDown className="w-3 h-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[120px]">
        {categories.map((cat) => (
          <DropdownMenuItem
            key={cat}
            onClick={() => onChange(cat)}
            className={cat === currentCategory ? "font-semibold" : ""}
          >
            <span className={`inline-block w-2 h-2 rounded-full me-2 ${getCategoryColor(cat).split(" ")[0].replace("/15", "/60")}`} />
            {cat}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
