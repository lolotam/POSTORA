import { useDarkTheme } from "@/hooks/useDarkTheme";
import { useAppTheme } from "@/hooks/useAppTheme";

/**
 * This component applies the dark theme variant and global app theme based on
 * admin settings. It doesn't render anything visible - it just sets the
 * data-dark-theme and data-app-theme attributes.
 */
export function ThemeApplier() {
  useDarkTheme();
  useAppTheme();
  return null;
}
