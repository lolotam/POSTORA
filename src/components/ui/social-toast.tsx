import { toast } from "sonner";
import { PlatformIcon } from "@/components/PlatformIcon";
import type { Platform } from "@/lib/types";

/** Attach the known platform explicitly; never guess it from translated message text. */
export function createSocialToast(platform: Platform) {
  const decorate = (method: "success" | "error" | "warning" | "info" | "loading" | "message") => (
    message: Parameters<typeof toast.success>[0],
    options?: Parameters<typeof toast.success>[1],
  ) => toast[method](message, {
    ...options,
    icon: <PlatformIcon platform={platform} size="md" />,
    style: { ...options?.style, direction: "ltr" },
  });
  return {
    ...toast,
    success: decorate("success"),
    error: decorate("error"),
    warning: decorate("warning"),
    info: decorate("info"),
    loading: decorate("loading"),
    message: decorate("message"),
  };
}
