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
import { Crown, Zap, Users, FileText, Share2 } from "lucide-react";

interface UpgradeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  limitType: "profile" | "social_account" | "post";
  currentUsage?: number;
  maxAllowed?: number;
}

export function UpgradeModal({
  open,
  onOpenChange,
  limitType,
  currentUsage = 0,
  maxAllowed = 0,
}: UpgradeModalProps) {
  const navigate = useNavigate();

  const limitMessages = {
    profile: {
      title: "Profile Limit Reached",
      description: `You're on the free tier with only ${maxAllowed} profile permitted.`,
      icon: Users,
      suggestion: "Upgrade to create more profiles and manage multiple brands.",
    },
    social_account: {
      title: "Social Media Limit Reached",
      description: `Free tier permits only ${maxAllowed} social media accounts per profile.`,
      icon: Share2,
      suggestion: "Upgrade to connect more social platforms and expand your reach.",
    },
    post: {
      title: "Monthly Post Limit Reached",
      description: `You've used all ${maxAllowed} posts for this month.`,
      icon: FileText,
      suggestion: "Posts renew on the 1st of next month, or upgrade for unlimited posting.",
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
              Upgrade benefits include:
            </div>
            <ul className="text-sm text-muted-foreground space-y-2 ms-6">
              <li className="flex items-center gap-2">
                <Zap className="w-3 h-3 text-primary" /> Unlimited profiles
              </li>
              <li className="flex items-center gap-2">
                <Zap className="w-3 h-3 text-primary" /> Unlimited social accounts
              </li>
              <li className="flex items-center gap-2">
                <Zap className="w-3 h-3 text-primary" /> Unlimited posts per month
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