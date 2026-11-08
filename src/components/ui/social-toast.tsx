import { toast } from "sonner";
import { PlatformIcon } from "@/components/PlatformIcon";
import type { Platform } from "@/lib/types";

/** Attach the known platform explicitly; never guess it from translated message text. */
export function createSocialToast(platform: Platform) {
  const decorate = (notify: typeof toast.success) => (
    message: Parameters<typeof toast.success>[0],
    options?: Parameters<typeof toast.success>[1],
  ) => notify(message, {
    ...options,
    icon: <PlatformIcon platform={platform} size="md" />,
    style: { ...options?.style, direction: "ltr" },
  });
  return {
    ...toast,
    success: decorate(toast.success),
    error: decorate(toast.error),
    warning: decorate(toast.warning),
    info: decorate(toast.info),
    loading: decorate(toast.loading),
    message: decorate(toast.message),
  };
}
