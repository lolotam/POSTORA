import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { ContactRecord } from "./contactCodecs";

export const CONTACTS_PAGE_SIZE = 50;
const STALE_MS = 5 * 60 * 1000;

export interface ContactFilters {
  search: string;
  groupId: string;
  page: number;
}

export interface ContactGroup {
  id: string;
  name: string;
  description: string | null;
  color: string;
}

function escapeIlike(term: string): string {
  return term.replace(/[%_]/g, "\\$&");
}

export function useContactGroups() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["whatsapp-groups", session?.user?.id],
    staleTime: STALE_MS,
    enabled: !!session?.user?.id,
    queryFn: async (): Promise<ContactGroup[]> => {
      const { data, error } = await supabase
        .from("whatsapp_contact_groups")
        .select("*")
        .order("name");
      if (error) throw error;
      return data || [];
    },
  });
}

export function useGroupMembers() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["whatsapp-group-members", session?.user?.id],
    staleTime: STALE_MS,
    enabled: !!session?.user?.id,
    queryFn: async (): Promise<{ group_id: string; contact_id: string }[]> => {
      const { data, error } = await supabase
        .from("whatsapp_contact_group_members")
        .select("group_id, contact_id");
      if (error) throw error;
      return data || [];
    },
  });
}

export function useContactsPage(filters: ContactFilters) {
  const { session } = useAuth();
  const { data: members = [] } = useGroupMembers();

  return useQuery({
    queryKey: ["whatsapp-contacts", session?.user?.id, filters, members.length],
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
    enabled: !!session?.user?.id,
    queryFn: async (): Promise<{ rows: ContactRecord[]; total: number }> => {
      let q = supabase
        .from("whatsapp_contacts")
        .select("*", { count: "exact" })
        .order("display_name", { ascending: true, nullsFirst: false });

      if (filters.search) {
        const t = `%${escapeIlike(filters.search)}%`;
        q = q.or(
          `display_name.ilike.${t},phone_number.ilike.${t},email.ilike.${t},company.ilike.${t}`,
        );
      }
      if (filters.groupId !== "all") {
        const ids = members
          .filter((m) => m.group_id === filters.groupId)
          .map((m) => m.contact_id);
        if (ids.length === 0) return { rows: [], total: 0 };
        q = q.in("id", ids);
      }
      const from = filters.page * CONTACTS_PAGE_SIZE;
      const { data, count, error } = await q.range(from, from + CONTACTS_PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data || []) as ContactRecord[], total: count || 0 };
    },
  });
}

export type ContactInput = Omit<ContactRecord, "id">;

export function useContactMutations() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
    qc.invalidateQueries({ queryKey: ["whatsapp-group-members"] });
  };

  const createContact = useMutation({
    mutationFn: async (input: ContactInput) => {
      if (!session?.user?.id) throw new Error("Not authenticated");
      const { error } = await supabase
        .from("whatsapp_contacts")
        .insert({ ...input, user_id: session.user.id });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const updateContact = useMutation({
    mutationFn: async ({ id, ...input }: ContactRecord) => {
      if (!session?.user?.id) throw new Error("Not authenticated");
      const { error } = await supabase.from("whatsapp_contacts").update(input).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const deleteContacts = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!session?.user?.id) throw new Error("Not authenticated");
      const { error } = await supabase.from("whatsapp_contacts").delete().in("id", ids);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const addToGroup = useMutation({
    mutationFn: async ({ groupId, contactIds }: { groupId: string; contactIds: string[] }) => {
      if (!session?.user?.id) throw new Error("Not authenticated");
      const rows = contactIds.map((contact_id) => ({ group_id: groupId, contact_id }));
      const { error } = await supabase
        .from("whatsapp_contact_group_members")
        .upsert(rows, { onConflict: "group_id,contact_id", ignoreDuplicates: true });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const removeFromGroup = useMutation({
    mutationFn: async ({ groupId, contactIds }: { groupId: string; contactIds: string[] }) => {
      if (!session?.user?.id) throw new Error("Not authenticated");
      const { error } = await supabase
        .from("whatsapp_contact_group_members")
        .delete()
        .eq("group_id", groupId)
        .in("contact_id", contactIds);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const addTag = useMutation({
    mutationFn: async ({ tag, contactIds }: { tag: string; contactIds: string[] }) => {
      if (!session?.user?.id) throw new Error("Not authenticated");
      const { data: contacts, error: fetchError } = await supabase
        .from("whatsapp_contacts")
        .select("id, tags")
        .in("id", contactIds);
      if (fetchError) throw fetchError;
      for (const c of contacts || []) {
        const tags = Array.from(new Set([...(c.tags || []), tag]));
        const { error } = await supabase
          .from("whatsapp_contacts")
          .update({ tags })
          .eq("id", c.id);
        if (error) throw error;
      }
    },
    onSuccess: invalidate,
  });

  return { createContact, updateContact, deleteContacts, addToGroup, removeFromGroup, addTag };
}

export function useGroupMutations() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["whatsapp-groups"] });
    qc.invalidateQueries({ queryKey: ["whatsapp-group-members"] });
  };

  const createGroup = useMutation({
    mutationFn: async (g: { name: string; description: string | null; color: string }) => {
      if (!session?.user?.id) throw new Error("Not authenticated");
      const { error } = await supabase
        .from("whatsapp_contact_groups")
        .insert({ ...g, user_id: session.user.id });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const updateGroup = useMutation({
    mutationFn: async (g: {
      id: string;
      name: string;
      description: string | null;
      color: string;
    }) => {
      if (!session?.user?.id) throw new Error("Not authenticated");
      const { id, ...rest } = g;
      const { error } = await supabase
        .from("whatsapp_contact_groups")
        .update(rest)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const deleteGroup = useMutation({
    mutationFn: async (id: string) => {
      if (!session?.user?.id) throw new Error("Not authenticated");
      const { error } = await supabase.from("whatsapp_contact_groups").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return { createGroup, updateGroup, deleteGroup };
}

export async function uploadContactAvatar(file: File, userId: string): Promise<string> {
  const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
  if (file.size > MAX_AVATAR_SIZE) {
    throw new Error("Image must be 5\u202fMB or smaller");
  }
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Image processing failed"))),
      "image/jpeg",
      0.85,
    ),
  );
  const path = `whatsapp-contact-avatars/${userId}_${Date.now()}.jpg`;
  const { data, error } = await supabase.storage
    .from("media")
    .upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw error;
  return supabase.storage.from("media").getPublicUrl(data.path).data.publicUrl;
}
