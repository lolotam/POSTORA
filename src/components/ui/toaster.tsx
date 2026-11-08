import { useToast } from "@/hooks/use-toast";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, platform, platforms, action, ...props }) {
        const icons = [...new Set(platform ? [platform] : platforms ?? [])];
        return (
          <Toast key={id} {...props}>
            <div className="flex min-w-0 items-center gap-3" dir={icons.length ? "ltr" : undefined}>
              {icons.length > 0 && <div className="flex shrink-0 gap-1" aria-hidden="true">{icons.map((name) => <PlatformIcon key={name} platform={name} size="lg" />)}</div>}
              <div className="grid min-w-0 gap-1" dir={icons.length ? "auto" : undefined}>
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && <ToastDescription>{description}</ToastDescription>}
              </div>
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
