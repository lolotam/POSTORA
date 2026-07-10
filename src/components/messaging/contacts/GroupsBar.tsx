import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
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
import { FolderPlus, MoreVertical, Trash2, Pencil, Plus } from "lucide-react";
import { useContactGroups, useGroupMembers, useGroupMutations } from "./useContacts";

interface GroupsBarProps {
  selectedGroup: string;
  onSelect: (id: string) => void;
}

const GROUP_COLORS = ["#6366f1", "#ef4444", "#10b981", "#f59e0b", "#ec4899", "#06b6d4"];

export function GroupsBar({ selectedGroup, onSelect }: GroupsBarProps) {
  const { toast } = useToast();
  const { data: groups = [] } = useContactGroups();
  const { data: members = [] } = useGroupMembers();
  const { createGroup, updateGroup, deleteGroup } = useGroupMutations();

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<{
    id: string;
    name: string;
    description: string;
    color: string;
  } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const countForGroup = (groupId: string) =>
    members.filter((m) => m.group_id === groupId).length;

  const openCreate = () => {
    setEditingGroup(null);
    setGroupDialogOpen(true);
  };

  const openRename = (g: { id: string; name: string; description: string | null; color: string }) => {
    setEditingGroup({
      id: g.id,
      name: g.name,
      description: g.description || "",
      color: g.color,
    });
    setGroupDialogOpen(true);
  };

  const saveGroup = async () => {
    if (!editingGroup) return;
    if (!editingGroup.name.trim()) return;
    try {
      if (editingGroup.id) {
        await updateGroup.mutateAsync(editingGroup);
      } else {
        await createGroup.mutateAsync({
          name: editingGroup.name,
          description: editingGroup.description || null,
          color: editingGroup.color,
        });
      }
      toast({ title: editingGroup.id ? "Group updated" : "Group created" });
      setGroupDialogOpen(false);
      setEditingGroup(null);
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteGroup.mutateAsync(deleteId);
      toast({ title: "Group deleted" });
      if (selectedGroup === deleteId) onSelect("all");
      setDeleteId(null);
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => onSelect("all")}
        className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
          selectedGroup === "all"
            ? "bg-primary text-primary-foreground"
            : "bg-muted hover:bg-muted/80"
        }`}
      >
        All contacts
      </button>

      {groups.map((g) => (
        <div key={g.id} className="flex items-center">
          <button
            onClick={() => onSelect(g.id)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              selectedGroup === g.id
                ? "bg-primary text-primary-foreground"
                : "bg-muted hover:bg-muted/80"
            }`}
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: g.color }}
            />
            {g.name}
            <span className="opacity-60">({countForGroup(g.id)})</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="ml-0.5 rounded-full p-1 hover:bg-muted">
                <MoreVertical className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => openRename(g)}>
                <Pencil className="h-3.5 w-3.5 mr-2" />
                Rename / Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setDeleteId(g.id)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}

      <Button variant="outline" size="sm" className="rounded-full" onClick={openCreate}>
        <Plus className="h-3.5 w-3.5 mr-1" />
        New group
      </Button>

      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {editingGroup?.id ? "Edit group" : "New group"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={editingGroup?.name || ""}
                onChange={(e) =>
                  setEditingGroup((p) => ({ ...(p || emptyGroup()), name: e.target.value }))
                }
                placeholder="e.g. VIP Customers"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Input
                value={editingGroup?.description || ""}
                onChange={(e) =>
                  setEditingGroup((p) => ({
                    ...(p || emptyGroup()),
                    description: e.target.value,
                  }))
                }
              />
            </div>
            <div>
              <Label>Color</Label>
              <div className="flex items-center gap-2">
                {GROUP_COLORS.map((color) => (
                  <button
                    key={color}
                    onClick={() =>
                      setEditingGroup((p) => ({ ...(p || emptyGroup()), color }))
                    }
                    aria-label={`Select color ${color}`}
                    aria-pressed={(editingGroup?.color || GROUP_COLORS[0]) === color}
                    className={`h-7 w-7 rounded-full border-2 ${
                      (editingGroup?.color || GROUP_COLORS[0]) === color
                        ? "border-foreground"
                        : "border-transparent"
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
                <FolderPlus className="h-4 w-4 text-muted-foreground ml-1" />
              </div>
            </div>
            <Button
              className="w-full"
              onClick={saveGroup}
              disabled={
                !editingGroup?.name.trim() ||
                createGroup.isPending ||
                updateGroup.isPending
              }
            >
              {editingGroup?.id ? "Save changes" : "Create group"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this group?</AlertDialogTitle>
            <AlertDialogDescription>
              The contacts will remain but will no longer be in this group. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function emptyGroup() {
  return { id: "", name: "", description: "", color: GROUP_COLORS[0] };
}
