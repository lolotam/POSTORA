import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Intercepts a transition while a form has unsaved edits.
 *
 * The pending transition is held as a closure, so the hook never needs to know what it
 * is guarding — one instance covers the account switch, the platform switch and the
 * surface toggles alike.
 */
export function useUnsavedChangesGuard(isDirty: boolean) {
  const [pending, setPending] = useState(false);
  const heldTransition = useRef<(() => void) | null>(null);

  const guard = useCallback(
    (proceed: () => void) => {
      if (!isDirty) {
        proceed();
        return;
      }
      heldTransition.current = proceed;
      setPending(true);
    },
    [isDirty],
  );

  const confirmDiscard = useCallback(() => {
    const proceed = heldTransition.current;
    heldTransition.current = null;
    setPending(false);
    proceed?.();
  }, []);

  const cancel = useCallback(() => {
    heldTransition.current = null;
    setPending(false);
  }, []);

  useEffect(() => {
    if (!isDirty) return;
    // Browsers ignore any custom message here and show their own text; preventDefault
    // plus a non-empty returnValue is all that still triggers the prompt.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  return { guard, pending, confirmDiscard, cancel };
}
