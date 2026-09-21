import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Crown, Zap, ImagePlus, FileText, Calendar, Share2, Users } from "lucide-react";

export type QuotaLimitType = 
  | "profile" 
  | "social_account" 
  | "post_monthly" 
  | "post_daily" 
  | "media_upload";

interface UpgradePromptModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  limitType: QuotaLimitType;
  currentUsage?: number;
  maxAllowed?: number;
}

export function UpgradePromptModal({
  open,
  onOpenChange,
  limitType,
  currentUsage = 0,
  maxAllowed = 0,
}: UpgradePromptModalProps) {
  const navigate = useNavigate();

  const limitMessages = {
    profile: {
      title: "Profile Limit Reached",
      description: `You've used all ${maxAllowed} profile(s) available on your plan.`,
      icon: Users,
      suggestion: "Upgrade to create more profiles and manage multiple brands.",
    },
    social_account: {
      title: "Social Account Limit Reached",
      description: `Your plan allows ${maxAllowed} social media accounts.`,
      icon: Share2,
      suggestion: "Upgrade to connect more social platforms and expand your reach.",
    },
    post_monthly: {
      title: "Monthly Post Limit Reached",
      description: `You've used all ${maxAllowed} posts for this month.`,
      icon: FileText,
      suggestion: "Posts renew on the 1st of next month, or upgrade for more posts.",
    },
    post_daily: {
      title: "Daily Post Limit Reached",
      description: `You've used all ${maxAllowed} post(s) for today.`,
      icon: Calendar,
      suggestion: "Your daily limit resets at midnight, or upgrade for more daily posts.",
    },
    media_upload: {
      title: "Daily Upload Limit Reached",
      description: `You've used all ${maxAllowed} media uploads for today.`,
      icon: ImagePlus,
      suggestion: "Upgrade to Pro for unlimited media uploads.",
    },
  };

  const { title, description, icon: Icon, suggestion } = limitMessages[limitType];

  const handleUpgrade = () => {
    onOpenChange(false);
    navigate("/pricing");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-center space-y-4">
          <div className="mx-auto w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
            <Icon className="w-8 h-8 text-amber-500" />
          </div>
          <DialogTitle className="text-xl">{title}</DialogTitle>
          <DialogDescription className="text-center space-y-2">
            <p>{description}</p>
            <p className="text-sm">{suggestion}</p>
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Crown className="w-4 h-4 text-primary" />
              Upgrade to Pro and get:
            </div>
            <ul className="text-sm text-muted-foreground space-y-2 ms-6">
              <li className="flex items-center gap-2">
                <Zap className="w-3 h-3 text-primary" /> 15 social profiles
              </li>
              <li className="flex items-center gap-2">
                <Zap className="w-3 h-3 text-primary" /> 30 social accounts
              </li>
              <li className="flex items-center gap-2">
                <Zap className="w-3 h-3 text-primary" /> 500 posts per month
              </li>
              <li className="flex items-center gap-2">
                <Zap className="w-3 h-3 text-primary" /> 30 posts per day
              </li>
              <li className="flex items-center gap-2">
                <Zap className="w-3 h-3 text-primary" /> Unlimited media uploads
              </li>
              <li className="flex items-center gap-2">
                <Zap className="w-3 h-3 text-primary" /> Priority support
              </li>
            </ul>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
            Maybe Later
          </Button>
          <Button onClick={handleUpgrade} className="w-full sm:w-auto gap-2">
            <Crown className="w-4 h-4" />
            View Plans
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
