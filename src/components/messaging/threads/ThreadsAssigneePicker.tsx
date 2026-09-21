import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, ChevronDown, UserCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";

interface Props {
  assignedTo: string | null;
  disabled?: boolean;
  onChange: (next: string | null) => void;
}

export function ThreadsAssigneePicker({ assignedTo, disabled, onChange }: Props) {
  const { t } = useTranslation("threads");
  const { session } = useAuth();
  const meId = session?.user?.id ?? null;
  const isMe = !!assignedTo && assignedTo === meId;
  const isUnassigned = !assignedTo;

  const label = isUnassigned
    ? t("assignee.unassigned", "Unassigned")
    : isMe
      ? t("assignee.me", "Me")
      : t("assignee.other", "Other");

  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 gap-1.5 text-xs"
          disabled={disabled}
        >
          {isUnassigned ? (
            <UserCircle2 className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Avatar className="h-4 w-4">
              <AvatarFallback className="text-[8px] bg-primary/10 text-primary">
                {isMe ? "ME" : "U"}
              </AvatarFallback>
            </Avatar>
          )}
          <span className="text-muted-foreground">{t("assignee.assigned", "Assigned:")}</span>
          <span className="font-medium">{label}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start font-normal h-8"
          onClick={() => onChange(null)}
        >
          <UserCircle2 className="h-3.5 w-3.5 me-2" />
          <span className="flex-1 text-start">{t("assignee.unassigned", "Unassigned")}</span>
          {isUnassigned && <Check className="h-3.5 w-3.5 text-primary" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start font-normal h-8"
          onClick={() => meId && onChange(meId)}
          disabled={!meId}
        >
          <Avatar className="h-4 w-4 me-2">
            <AvatarFallback className="text-[8px] bg-primary/10 text-primary">ME</AvatarFallback>
          </Avatar>
          <span className="flex-1 text-start">{t("assignee.me", "Me")}</span>
          {isMe && <Check className="h-3.5 w-3.5 text-primary" />}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
