import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COUNTRY_DIAL_CODES, splitPhone } from "./contactCodecs";

/** Explicit t() calls so the coverage gate can see every country key. */
export function countryLabel(t: TFunction, code: string, fallback: string): string {
  switch (code) {
    case "KW": return t("countries.KW", "Kuwait");
    case "SA": return t("countries.SA", "Saudi Arabia");
    case "AE": return t("countries.AE", "UAE");
    case "QA": return t("countries.QA", "Qatar");
    case "BH": return t("countries.BH", "Bahrain");
    case "OM": return t("countries.OM", "Oman");
    case "EG": return t("countries.EG", "Egypt");
    case "JO": return t("countries.JO", "Jordan");
    case "LB": return t("countries.LB", "Lebanon");
    case "IQ": return t("countries.IQ", "Iraq");
    case "SY": return t("countries.SY", "Syria");
    case "PS": return t("countries.PS", "Palestine");
    case "YE": return t("countries.YE", "Yemen");
    case "LY": return t("countries.LY", "Libya");
    case "TN": return t("countries.TN", "Tunisia");
    case "DZ": return t("countries.DZ", "Algeria");
    case "MA": return t("countries.MA", "Morocco");
    case "SD": return t("countries.SD", "Sudan");
    case "TR": return t("countries.TR", "Turkey");
    case "US": return t("countries.US", "United States");
    case "GB": return t("countries.GB", "United Kingdom");
    case "DE": return t("countries.DE", "Germany");
    case "FR": return t("countries.FR", "France");
    case "ES": return t("countries.ES", "Spain");
    case "IT": return t("countries.IT", "Italy");
    case "NL": return t("countries.NL", "Netherlands");
    case "SE": return t("countries.SE", "Sweden");
    case "CH": return t("countries.CH", "Switzerland");
    case "RU": return t("countries.RU", "Russia");
    case "IN": return t("countries.IN", "India");
    case "PK": return t("countries.PK", "Pakistan");
    case "BD": return t("countries.BD", "Bangladesh");
    case "LK": return t("countries.LK", "Sri Lanka");
    case "NP": return t("countries.NP", "Nepal");
    case "PH": return t("countries.PH", "Philippines");
    case "ID": return t("countries.ID", "Indonesia");
    case "MY": return t("countries.MY", "Malaysia");
    case "SG": return t("countries.SG", "Singapore");
    case "TH": return t("countries.TH", "Thailand");
    case "VN": return t("countries.VN", "Vietnam");
    case "CN": return t("countries.CN", "China");
    case "JP": return t("countries.JP", "Japan");
    case "KR": return t("countries.KR", "South Korea");
    case "AU": return t("countries.AU", "Australia");
    case "NZ": return t("countries.NZ", "New Zealand");
    case "CA": return t("countries.CA", "Canada");
    case "MX": return t("countries.MX", "Mexico");
    case "BR": return t("countries.BR", "Brazil");
    case "AR": return t("countries.AR", "Argentina");
    case "ZA": return t("countries.ZA", "South Africa");
    case "NG": return t("countries.NG", "Nigeria");
    case "KE": return t("countries.KE", "Kenya");
    case "ET": return t("countries.ET", "Ethiopia");
    case "IR": return t("countries.IR", "Iran");
    case "AF": return t("countries.AF", "Afghanistan");
    default: return fallback;
  }
}

interface PhoneInputProps {
  value: string;
  onChange: (digits: string) => void;
  placeholder?: string;
}

export function PhoneInput({ value, onChange, placeholder }: PhoneInputProps) {
  const { t } = useTranslation("inbox");
  const { dialCode, national } = splitPhone(value);

  const selectedCode =
    COUNTRY_DIAL_CODES.find((c) => c.dial === dialCode)?.code ?? "KW";

  const handleCodeChange = (code: string) => {
    const dial = COUNTRY_DIAL_CODES.find((c) => c.code === code)!.dial;
    onChange(dial + national);
  };

  return (
    <div className="flex gap-2">
      <Select value={selectedCode} onValueChange={handleCodeChange}>
        <SelectTrigger className="w-[130px] shrink-0">
          <SelectValue placeholder={t("phone.code", "Code")} />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {COUNTRY_DIAL_CODES.map((c) => (
            <SelectItem key={c.code} value={c.code}>
              {c.flag} +{c.dial} {countryLabel(t, c.code, c.name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        inputMode="tel"
        value={national}
        placeholder={placeholder || "5568 3677"}
        onChange={(e) =>
          onChange((dialCode || "965") + e.target.value.replace(/\D/g, ""))
        }
      />
    </div>
  );
}
