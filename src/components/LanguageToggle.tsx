import { useEffect, useState } from "react";
import { Languages } from "lucide-react";
import i18next from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function LanguageToggle() {
  const [currentLang, setCurrentLang] = useState<string>(i18next.language || "en");

  useEffect(() => {
    const onLanguageChanged = (lng: string) => {
      setCurrentLang(lng);
    };
    i18next.on("languageChanged", onLanguageChanged);
    return () => {
      i18next.off("languageChanged", onLanguageChanged);
    };
  }, []);

  const isArabic = currentLang.startsWith("ar");

  const toggleLanguage = () => {
    const nextLang = isArabic ? "en" : "ar";
    void i18next.changeLanguage(nextLang);
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={toggleLanguage}
          >
            <Languages className="h-4 w-4" />
            <span className="sr-only">Toggle language</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Switch to {isArabic ? "English" : "العربية"}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
