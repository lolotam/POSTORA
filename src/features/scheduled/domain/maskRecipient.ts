/** Name when we have one; otherwise the last four digits only. */
export function maskRecipient(phone: string, name: string | null | undefined): string {
  const trimmedName = name?.trim();
  if (trimmedName) return trimmedName;
  const digits = phone.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  if (!last4) return "••••";
  return `•••• ${last4}`;
}
