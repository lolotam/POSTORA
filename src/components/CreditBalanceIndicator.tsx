import { useCredits } from "@/hooks/useCredits";
import { useUserRole } from "@/hooks/useUserRole";
import { Zap, Shield } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function CreditBalanceIndicator() {
  const { balance, isLoading } = useCredits();
  const { isAdmin } = useUserRole();
  const navigate = useNavigate();

  // Admin view - show unlimited, non-clickable
  if (isAdmin) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-green-500/10">
            <Shield className="w-4 h-4 text-green-500" />
            <span className="font-medium text-green-600">∞</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>Admin • Unlimited AI Access</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Regular user view - clickable to buy more
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/credits")}
          className="gap-2 px-3"
        >
          <Zap className="w-4 h-4 text-primary" />
          <span className="font-medium">
            {isLoading ? "..." : balance.toLocaleString()}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>AI Credits • Click to buy more</p>
      </TooltipContent>
    </Tooltip>
  );
}