import { useEffect } from "react";

interface ReviewShortcuts {
  ready: boolean;
  overlayOpen: boolean;
  canReject: boolean;
  onApprove: () => void;
  onReject: () => void;
  onNext: () => void;
}

export function useReviewShortcuts({ ready, overlayOpen, canReject, onApprove, onReject, onNext }: ReviewShortcuts) {
  useEffect(() => {
    if (!ready || overlayOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.isContentEditable || target.closest("input, textarea, select")) return;
      if (target.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']")) return;
      // The media picker and other child overlays are outside workspace state.
      if (document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open'], [role='menu'][data-state='open'], [role='listbox'][data-state='open']")) return;
      if (event.code === "KeyA") {
        event.preventDefault();
        onApprove();
      } else if (event.code === "KeyR" && canReject) {
        event.preventDefault();
        onReject();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onNext();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, overlayOpen, canReject, onApprove, onReject, onNext]);
}
