// Strict customer-phone parser for store-event flows (Spec B §8.14).
// ecommerce-whatsapp-api keeps its own parser; do not route it through here.

const COUNTRIES: Record<string, { code: string; national: number }> = {
  KW: { code: "965", national: 8 },
  SA: { code: "966", national: 9 },
  AE: { code: "971", national: 9 },
  QA: { code: "974", national: 8 },
  BH: { code: "973", national: 8 },
  OM: { code: "968", national: 8 },
  EG: { code: "20", national: 10 },
  JO: { code: "962", national: 9 },
  IQ: { code: "964", national: 10 },
  LB: { code: "961", national: 8 },
  US: { code: "1", national: 10 },
  GB: { code: "44", national: 10 },
};

function acceptable(digits: string): string | null {
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** Digits with country code, or null when the number is not a plausible international phone. */
export function parseCustomerPhone(raw: string, country: string | null): string | null {
  const stripped = raw.trim().replace(/[\s.\-()]/g, "");
  if (!stripped) return null;
  let international = false;
  let digits = stripped;
  if (digits.startsWith("+")) {
    international = true;
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }
  if (!/^\d+$/.test(digits)) return null;
  if (international) return acceptable(digits);
  const known = country ? COUNTRIES[country.trim().toUpperCase()] : undefined;
  if (!known) return null;
  const national = digits.startsWith("0") ? digits.slice(1) : digits;
  if (!/^\d+$/.test(national)) return null;
  if (national.startsWith(known.code) && national.length === known.code.length + known.national) {
    return acceptable(national);
  }
  if (national.length === known.national) return acceptable(known.code + national);
  return null;
}

export type WhatsAppAddressing = {
  mode: "cloud_api" | "coexistence" | "evolution_qr";
  phoneNumberId: string | null;
  platformUserId: string;
};

/** Cloud and coexistence key off the phone-number id; QR keys off the platform user id. */
export function whatsappConversationId(addressing: WhatsAppAddressing, phone: string): string {
  const head = addressing.mode === "evolution_qr" ? addressing.platformUserId : (addressing.phoneNumberId ?? "");
  return `wa_${head}_${phone}`;
}
