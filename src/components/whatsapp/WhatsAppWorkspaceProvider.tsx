import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspaces, type WhatsAppWorkspace, type WorkspaceRole } from "@/hooks/useWhatsAppWorkspace";

export const WHATSAPP_WORKSPACE_STORAGE_KEY = "postora.whatsapp.active-workspace";

interface WhatsAppWorkspaceContextValue {
  workspaces: WhatsAppWorkspace[];
  activeWorkspace: WhatsAppWorkspace | undefined;
  activeWorkspaceId: string | undefined;
  setActiveWorkspaceId: (workspaceId: string) => void;
  activeRole: WorkspaceRole | undefined;
  isLoading: boolean;
  error: Error | null;
}

const WhatsAppWorkspaceContext = createContext<WhatsAppWorkspaceContextValue | undefined>(undefined);

function storedWorkspaceId() {
  return localStorage.getItem(WHATSAPP_WORKSPACE_STORAGE_KEY) || undefined;
}

export function WhatsAppWorkspaceProvider({ children }: { children: ReactNode }) {
  const { data: workspaces = [], isLoading, error } = useWorkspaces();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | undefined>(storedWorkspaceId);

  useEffect(() => {
    if (isLoading || error) return;

    const selectedWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
    const fallbackWorkspace = workspaces.find((workspace) => workspace.is_personal) ?? workspaces[0];
    const nextWorkspaceId = selectedWorkspace?.id ?? fallbackWorkspace?.id;

    if (nextWorkspaceId !== activeWorkspaceId) setActiveWorkspaceId(nextWorkspaceId);
    if (nextWorkspaceId) {
      localStorage.setItem(WHATSAPP_WORKSPACE_STORAGE_KEY, nextWorkspaceId);
    } else {
      localStorage.removeItem(WHATSAPP_WORKSPACE_STORAGE_KEY);
    }
  }, [activeWorkspaceId, error, isLoading, workspaces]);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const contextValue = useMemo<WhatsAppWorkspaceContextValue>(() => ({
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    setActiveWorkspaceId,
    activeRole: activeWorkspace?.role,
    isLoading,
    error,
  }), [activeWorkspace, activeWorkspaceId, error, isLoading, workspaces]);

  return <WhatsAppWorkspaceContext.Provider value={contextValue}>{children}</WhatsAppWorkspaceContext.Provider>;
}

// Provider modules intentionally export their consumer hook alongside the provider.
// eslint-disable-next-line react-refresh/only-export-components
export function useWhatsAppWorkspaceContext() {
  const context = useContext(WhatsAppWorkspaceContext);
  if (!context) {
    throw new Error("useWhatsAppWorkspaceContext must be used within a WhatsAppWorkspaceProvider");
  }
  return context;
}
