import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, Upload } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { ContactRecord } from "./contacts/contactCodecs";
import {
  useContactsPage,
  useContactGroups,
  useGroupMembers,
} from "./contacts/useContacts";
import { GroupsBar } from "./contacts/GroupsBar";
import { ContactsTable } from "./contacts/ContactsTable";
import { ContactFormDialog } from "./contacts/ContactFormDialog";
import { ContactImportDialog } from "./contacts/ContactImportDialog";
import { ContactExportMenu } from "./contacts/ContactExportMenu";

export function WhatsAppContactsContent() {
  const { t } = useTranslation("whatsapp");
  const { session } = useAuth();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<ContactRecord | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filters = useMemo(
    () => ({ search, groupId, page }),
    [search, groupId, page],
  );

  const { data, isLoading } = useContactsPage(filters);
  const { data: groups = [] } = useContactGroups();
  const { data: members = [] } = useGroupMembers();

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  const selectedContacts = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (c: ContactRecord) => {
    setEditing(c);
    setFormOpen(true);
  };

  const exportFetcher = async (): Promise<ContactRecord[]> => {
    let q = supabase
      .from("whatsapp_contacts")
      .select("*")
      .order("display_name", { ascending: true, nullsFirst: false });
    if (search) {
      const pattern = `%${search.replace(/[%_]/g, "\\$&").replace(/,/g, " ")}%`;
      q = q.or(
        `display_name.ilike.${pattern},phone_number.ilike.${pattern},email.ilike.${pattern},company.ilike.${pattern}`,
      );
    }
    if (groupId !== "all") {
      const ids = members
        .filter((m) => m.group_id === groupId)
        .map((m) => m.contact_id);
      if (ids.length === 0) return [];
      q = q.in("id", ids);
    }
    const { data: exportRows, error } = await q;
    if (error) throw error;
    return (exportRows || []) as ContactRecord[];
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <p className="text-sm text-muted-foreground">
          {t("contacts.summary", "{{contacts}} contacts · {{groups}} groups", { contacts: total, groups: groups.length })}
        </p>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            {t("contacts.importCsv", "Import CSV")}
          </Button>
          <ContactExportMenu getContacts={exportFetcher} />
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4 mr-2" />
            {t("contacts.add", "Add Contact")}
          </Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t("contacts.search", "Search contacts...")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="pl-9"
        />
      </div>

      <GroupsBar selectedGroup={groupId} onSelect={setGroupId} />

      <ContactsTable
        rows={rows}
        total={total}
        page={page}
        onPageChange={setPage}
        selected={selected}
        onSelectedChange={setSelected}
        onEdit={openEdit}
        loading={isLoading}
        selectedContacts={selectedContacts}
      />

      <ContactFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editing}
      />
      <ContactImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
