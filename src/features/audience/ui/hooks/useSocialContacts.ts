import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/hooks/use-toast";
import type { ContactFilters } from "../../domain/socialContact";
import {
  deleteContact, fetchContactStats, fetchDistinctTags, listContacts, updateContact, type ContactPatch,
} from "../../infrastructure/socialContactsRepository";

const ROOT = "social-contacts";

export function useSocialContacts(filters: ContactFilters, page: number) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [ROOT, "list", user?.id, filters, page],
    queryFn: () => listContacts(filters, page),
    enabled: !!user,
    placeholderData: (prev) => prev,
  });
}

export function useSocialContactStats() {
  const { user } = useAuth();
  return useQuery({ queryKey: [ROOT, "stats", user?.id], queryFn: fetchContactStats, enabled: !!user });
}

export function useSocialContactTags() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [ROOT, "tags", user?.id],
    queryFn: () => fetchDistinctTags(user!.id),
    enabled: !!user,
  });
}

function useInvalidateContacts() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [ROOT] });
}

export function useUpdateSocialContact() {
  const invalidate = useInvalidateContacts();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ContactPatch }) => updateContact(id, patch),
    onSuccess: invalidate,
    onError: (error: Error) => toast({ title: "Could not save contact", description: error.message, variant: "destructive" }),
  });
}

export function useDeleteSocialContact() {
  const invalidate = useInvalidateContacts();
  return useMutation({
    mutationFn: deleteContact,
    onSuccess: invalidate,
    onError: (error: Error) => toast({ title: "Could not delete contact", description: error.message, variant: "destructive" }),
  });
}
