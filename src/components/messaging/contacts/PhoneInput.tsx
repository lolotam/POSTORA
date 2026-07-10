import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COUNTRY_DIAL_CODES, splitPhone } from "./contactCodecs";

interface PhoneInputProps {
  value: string;
  onChange: (digits: string) => void;
  placeholder?: string;
}

export function PhoneInput({ value, onChange, placeholder }: PhoneInputProps) {
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
          <SelectValue placeholder="Code" />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {COUNTRY_DIAL_CODES.map((c) => (
            <SelectItem key={c.code} value={c.code}>
              {c.flag} +{c.dial} {c.name}
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
