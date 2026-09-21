import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useToast } from "@/hooks/use-toast";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Tag,
  Trash2,
  Users,
  X,
  Download,
} from "lucide-react";
import type { ContactRecord } from "./contactCodecs";
import {
  CONTACTS_PAGE_SIZE,
  useContactGroups,
  useContactMutations,
} from "./useContacts";
import { ContactExportMenu } from "./ContactExportMenu";

interface ContactsTableProps {
  rows: ContactRecord[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  selected: Set<string>;
  onSelectedChange: (s: Set<string>) => void;
  onEdit: (c: ContactRecord) => void;
  loading: boolean;
  selectedContacts: ContactRecord[];
}

export function ContactsTable({
  rows,
  total,
  page,
  onPageChange,
  selected,
  onSelectedChange,
  onEdit,
  loading,
  selectedContacts,
}: ContactsTableProps) {
  const { t } = useTranslation("inbox");
  const pageIds = rows.map((r) => r.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const somePageSelected = pageIds.some((id) => selected.has(id));

  const togglePage = () => {
    const next = new Set(selected);
    if (allPageSelected) {
      pageIds.forEach((id) => next.delete(id));
    } else {
      pageIds.forEach((id) => next.add(id));
    }
    onSelectedChange(next);
  };

  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  const from = total === 0 ? 0 : page * CONTACTS_PAGE_SIZE + 1;
  const to = Math.min((page + 1) * CONTACTS_PAGE_SIZE, total);
  const totalPages = Math.ceil(total / CONTACTS_PAGE_SIZE);

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <BulkActionsBar
          selected={selected}
          selectedContacts={selectedContacts}
          onClear={() => onSelectedChange(new Set())}
        />
      )}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>{t("contacts.empty", "No contacts found. Add contacts manually or import a CSV file.")}</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={
                          allPageSelected
                            ? true
                            : somePageSelected
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={togglePage}
                        aria-label={t("contacts.selectAllPage", "Select all contacts on page")}
                      />
                    </TableHead>
                    <TableHead>{t("contacts.name", "Name")}</TableHead>
                    <TableHead>{t("contacts.phone", "Phone")}</TableHead>
                    <TableHead>{t("contacts.email", "Email")}</TableHead>
                    <TableHead>{t("contacts.tags", "Tags")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c) => {
                    const initials =
                      ((c.first_name?.[0] || "") + (c.last_name?.[0] || "")) ||
                      (c.display_name?.[0] || "?");
                    return (
                      <TableRow
                        key={c.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => onEdit(c)}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selected.has(c.id)}
                            onCheckedChange={() => toggleRow(c.id)}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Avatar className="h-8 w-8">
                              <AvatarImage src={c.avatar_url || undefined} />
                              <AvatarFallback className="text-xs">
                                {initials}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div className="font-medium truncate">
                                {c.display_name || "—"}
                              </div>
                              {(c.job_title || c.company) && (
                                <div className="text-xs text-muted-foreground truncate">
                                  {[c.job_title, c.company].filter(Boolean).join(" · ")}
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          +{c.phone_number}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {c.email || "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1 flex-wrap">
                            {(c.tags || []).map((tag) => (
                              <Badge
                                key={tag}
                                variant="secondary"
                                className="text-xs"
                              >
                                <Tag className="h-3 w-3 me-1" />
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <p className="text-sm text-muted-foreground">
                  {t("contacts.showingRange", "Showing {{from}}–{{to}} of {{total}}", { from, to, total })}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => onPageChange(page - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    {t("contacts.prev", "Prev")}
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {page + 1} / {totalPages || 1}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages - 1}
                    onClick={() => onPageChange(page + 1)}
                  >
                    {t("common:next", "Next")}
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface BulkActionsBarProps {
  selected: Set<string>;
  selectedContacts: ContactRecord[];
  onClear: () => void;
}

function BulkActionsBar({ selected, selectedContacts, onClear }: BulkActionsBarProps) {
  const { t } = useTranslation("inbox");
  const { toast } = useToast();
  const { data: groups = [] } = useContactGroups();
  const { deleteContacts, addToGroup, removeFromGroup, addTag } =
    useContactMutations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");

  const ids = [...selected];

  const handleDelete = async () => {
    try {
      await deleteContacts.mutateAsync(ids);
      toast({ title: ids.length > 1 ? t("toast.contactsDeletedMany", "{{count}} contacts deleted", { count: ids.length }) : t("toast.contactsDeletedOne", "{{count}} contact deleted", { count: ids.length }) });
      onClear();
      setDeleteOpen(false);
    } catch (e) {
      toast({ title: t("errors.deleteFailed", "Delete failed"), description: (e as Error).message, variant: "destructive" });
    }
  };

  const handleAddGroup = async (groupId: string) => {
    try {
      await addToGroup.mutateAsync({ groupId, contactIds: ids });
      toast({ title: t("toast.addedToGroup", "Added to group") });
    } catch (e) {
      toast({ title: t("errors.failed", "Failed"), description: (e as Error).message, variant: "destructive" });
    }
  };

  const handleRemoveGroup = async (groupId: string) => {
    try {
      await removeFromGroup.mutateAsync({ groupId, contactIds: ids });
      toast({ title: t("toast.removedFromGroup", "Removed from group") });
    } catch (e) {
      toast({ title: t("errors.failed", "Failed"), description: (e as Error).message, variant: "destructive" });
    }
  };

  const handleAddTag = async () => {
    const tag = tagInput.trim();
    if (!tag) return;
    try {
      await addTag.mutateAsync({ tag, contactIds: ids });
      toast({ title: t("toast.tagAdded", "Tag \"{{tag}}\" added to {{count}} contacts", { tag, count: ids.length }) });
      setTagInput("");
    } catch (e) {
      toast({ title: t("errors.failed", "Failed"), description: (e as Error).message, variant: "destructive" });
    }
  };

  const getSelectedFetcher = () =>
    Promise.resolve(selectedContacts);

  return (
    <div className="flex items-center gap-2 flex-wrap rounded-lg border bg-muted/50 p-2">
      <span className="text-sm font-medium px-2">
        {t("contacts.selected", "{{count}} selected", { count: selected.size })}
      </span>

      <div className="h-4 w-px bg-border" />

      <Select onValueChange={handleAddGroup}>
        <SelectTrigger className="h-8 w-[140px]">
          <SelectValue placeholder={t("contacts.addToGroup", "Add to group")} />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectItem key={g.id} value={g.id}>
              {g.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select onValueChange={handleRemoveGroup}>
        <SelectTrigger className="h-8 w-[150px]">
          <SelectValue placeholder={t("contacts.removeFromGroup", "Remove from group")} />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectItem key={g.id} value={g.id}>
              {g.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex items-center gap-1">
        <Input
          className="h-8 w-[120px]"
          placeholder={t("contacts.addTag", "Add tag...")}
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
        />
        <Button variant="outline" size="sm" className="h-8" onClick={handleAddTag}>
          <Tag className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ContactExportMenu
        getContacts={getSelectedFetcher}
        label={t("contacts.exportSelected", "Export selected")}
        triggerSize="sm"
      >
        <Download className="h-3.5 w-3.5 me-1" />
      </ContactExportMenu>

      <Button
        variant="outline"
        size="sm"
        className="h-8 text-destructive hover:text-destructive"
        onClick={() => setDeleteOpen(true)}
      >
        <Trash2 className="h-3.5 w-3.5 me-1" />
        {t("contacts.deleteCount", "Delete ({{count}})", { count: selected.size })}
      </Button>

      <Button variant="ghost" size="sm" className="h-8" onClick={onClear}>
        <X className="h-3.5 w-3.5" />
        {t("common:clear", "Clear")}
      </Button>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("contacts.deleteMany", "Delete {{count}} contacts?", { count: selected.size })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("contacts.deleteUndo", "This action cannot be undone. These contacts will be permanently removed.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common:delete", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
