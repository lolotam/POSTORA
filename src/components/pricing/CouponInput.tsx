import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tag, X, Check } from "lucide-react";

interface CouponInputProps {
  couponCode: string;
  setCouponCode: (code: string) => void;
}

export function CouponInput({ couponCode, setCouponCode }: CouponInputProps) {
  const [showInput, setShowInput] = useState(false);

  if (!showInput) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShowInput(true)}
        className="gap-2 text-muted-foreground"
      >
        <Tag className="w-4 h-4" />
        Have a promo code?
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Tag className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Enter promo code"
          value={couponCode}
          onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
          className="ps-9 w-48 uppercase"
        />
      </div>
      <Button variant="ghost" size="icon" onClick={() => { setShowInput(false); setCouponCode(""); }}>
        <X className="w-4 h-4" />
      </Button>
      {couponCode && (
        <Badge variant="secondary" className="gap-1">
          <Check className="w-3 h-3" />
          {couponCode}
        </Badge>
      )}
    </div>
  );
}
