import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { TimezoneSelector } from "@/components/post/TimezoneSelector";
import { Globe, Loader2 } from "lucide-react";

interface TimezoneSectionProps {
  userId: string;
  initialTimezone: string | null | undefined;
  onRefresh: () => Promise<void>;
}

export function TimezoneSection({ userId, initialTimezone, onRefresh }: TimezoneSectionProps) {
  const [timezone, setTimezone] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (initialTimezone) {
      setTimezone(initialTimezone);
    }
  }, [initialTimezone]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ preferred_timezone: timezone || null })
        .eq("id", userId);

      if (error) throw error;

      await onRefresh();

      toast({
        title: "Timezone saved",
        description: timezone
          ? `Your preferred timezone is now ${timezone}.`
          : "Timezone preference has been cleared.",
      });
    } catch (error) {
      console.error("Timezone save error:", error);
      toast({
        title: "Failed to save timezone",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanged = timezone !== (initialTimezone || "");

  return (
    <div className="rounded-xl border border-border bg-card/50 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Globe className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">Timezone</h2>
          <p className="text-sm text-muted-foreground">
            Set your preferred timezone for scheduling posts
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <TimezoneSelector
          value={timezone}
          onChange={setTimezone}
        />
        <Button onClick={handleSave} disabled={isSaving || !hasChanged}>
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Timezone"
          )}
        </Button>
      </div>
    </div>
  );
}
