import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, FileSpreadsheet, FileText, Contact } from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  contactsToCsvRows,
  contactsToVCardFile,
  type ContactRecord,
} from "./contactCodecs";
import type { ReactNode } from "react";

interface ContactExportMenuProps {
  getContacts: () => Promise<ContactRecord[]>;
  label?: string;
  triggerSize?: "default" | "sm" | "lg" | "icon";
  children?: ReactNode;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ContactExportMenu({
  getContacts,
  label = "Export",
  triggerSize,
  children,
}: ContactExportMenuProps) {
  const { toast } = useToast();

  const handleCsv = async () => {
    try {
      const contacts = await getContacts();
      const rows = contactsToCsvRows(contacts);
      const csv = Papa.unparse(rows);
      downloadBlob(new Blob([csv], { type: "text/csv" }), "postora-contacts.csv");
    } catch (e) {
      toast({
        title: "CSV export failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleXlsx = async () => {
    try {
      const contacts = await getContacts();
      const rows = contactsToCsvRows(contacts);
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Contacts");
      XLSX.writeFile(wb, "postora-contacts.xlsx");
    } catch (e) {
      toast({
        title: "Excel export failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleVCard = async () => {
    try {
      const contacts = await getContacts();
      const vcf = contactsToVCardFile(contacts);
      downloadBlob(new Blob([vcf], { type: "text/vcard" }), "postora-contacts.vcf");
    } catch (e) {
      toast({
        title: "vCard export failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={triggerSize}>
          {children}
          {label}
          <ChevronDown className="h-3.5 w-3.5 ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleCsv}>
          <FileText className="h-4 w-4 mr-2" />
          Export as CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleXlsx}>
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Export as Excel (.xlsx)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleVCard}>
          <Contact className="h-4 w-4 mr-2" />
          Export as vCard (.vcf)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
