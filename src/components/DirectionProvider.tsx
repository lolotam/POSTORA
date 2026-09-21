import { useEffect, useState, type ReactNode } from "react";
import { DirectionProvider as RadixDirectionProvider } from "@radix-ui/react-direction";
import i18next from "@/i18n";

/**
 * Tells Radix which way the document runs.
 *
 * Radix primitives do NOT read `<html dir>`. Without this provider every one of
 * them assumes `ltr` internally, which is not a styling detail: `DropdownMenu`
 * and `Select` resolve `align="start"/"end"` and their collision-aware `data-side`
 * against it, and `Tabs` maps ArrowLeft/ArrowRight to previous/next through it. In
 * Arabic that produces menus that open off the wrong edge and arrow keys that move
 * the selection backwards, neither of which a CSS rule can correct.
 *
 * Reads `i18next.dir()` rather than deriving direction from the language code, so
 * a future RTL language inherits this for free, and re-renders on
 * `languageChanged` because the toggle switches language without a reload.
 */
export function DirectionProvider({ children }: { children: ReactNode }) {
  const [dir, setDir] = useState<"ltr" | "rtl">(() => i18next.dir());

  useEffect(() => {
    const onLanguageChanged = () => setDir(i18next.dir());
    i18next.on("languageChanged", onLanguageChanged);
    return () => {
      i18next.off("languageChanged", onLanguageChanged);
    };
  }, []);

  return <RadixDirectionProvider dir={dir}>{children}</RadixDirectionProvider>;
}
