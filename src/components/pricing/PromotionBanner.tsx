import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Flame, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface PromotionBannerProps {
  remainingSlots?: number;
  isActive?: boolean;
}

export function PromotionBanner({ remainingSlots = 100, isActive = true }: PromotionBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const wasDismissed = localStorage.getItem("promo_banner_dismissed");
    if (wasDismissed) setDismissed(true);
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem("promo_banner_dismissed", "true");
  };

  if (dismissed || !isActive || remainingSlots <= 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="relative overflow-hidden rounded-2xl border border-primary/30 p-6 mb-8 bg-primary/10"
      >
        <button
          onClick={handleDismiss}
          className="absolute top-3 end-3 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex flex-col md:flex-row items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center">
              <Flame className="w-6 h-6 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-lg font-bold">🔥 Early Bird Offer</h3>
                <Badge variant="default" className="bg-primary text-primary-foreground">
                  Limited
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Get Pro for just <span className="text-primary font-bold">$5/mo</span> or{" "}
                <span className="text-primary font-bold">$99.99/yr</span> — available for the first 100 users only!
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 md:ms-auto shrink-0">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">
              <span className="text-primary font-bold">{remainingSlots}</span> spots remaining
            </span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
