import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Loader2, User, Info } from "lucide-react";

interface AddProfileFormProps {
  newProfileName: string;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
  isPending: boolean;
}

export function AddProfileForm({
  newProfileName,
  onNameChange,
  onSubmit,
  isPending,
}: AddProfileFormProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Add New Profile</label>
        <span className="text-xs text-muted-foreground">
          Create a new profile to manage social accounts
        </span>
      </div>
      <div className="flex gap-3">
        <div className="flex-1 relative">
          <User className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="e.g. business_account, personal11"
            value={newProfileName}
            onChange={(e) => onNameChange(e.target.value)}
            className="ps-10"
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          />
        </div>
        <Button
          onClick={onSubmit}
          disabled={isPending || !newProfileName.trim()}
        >
          {isPending ? (
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
          ) : (
            <Plus className="w-4 h-4 me-2" />
          )}
          Add Profile
        </Button>
      </div>
      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <Info className="w-3 h-3" />
        Allowed characters: letters, numbers, underscores, hyphens, and @
      </p>
    </div>
  );
}
