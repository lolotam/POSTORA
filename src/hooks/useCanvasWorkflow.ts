import { useState, useCallback } from "react";
import { Node, Edge } from "@xyflow/react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useQuotas } from "@/hooks/useQuotas";
import { isMediaQuotaMessage, mediaQuotaHumanMessage } from "@/components/media/uploadErrors";
import type { Json } from "@/integrations/supabase/types";

export interface WorkflowData {
  id?: string;
  name: string;
  description?: string;
  nodes: Node[];
  edges: Edge[];
  viewport?: { x: number; y: number; zoom: number };
}

interface ExecutionResult {
  success: boolean;
  postId?: string;
  errors?: string[];
}

type PlatformNodeData = {
  selectedAccountIds?: string[];
  enabledPlatforms?: string[];
  settings?: Json;
  scheduledAt?: string;
};

type ProcessPostResult = { success: boolean; platform?: string; error?: string };

export function useCanvasWorkflow() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { canCreatePost } = useQuotas();
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [currentWorkflowId, setCurrentWorkflowId] = useState<string | null>(null);

  const saveWorkflow = useCallback(async (workflow: WorkflowData): Promise<string | null> => {
    if (!user) {
      toast({ title: "Login required", variant: "destructive" });
      return null;
    }

    setIsSaving(true);
    try {
      const workflowData = {
        user_id: user.id,
        name: workflow.name || "Untitled Workflow",
        description: workflow.description || null,
        nodes: workflow.nodes as unknown as Json,
        edges: workflow.edges as unknown as Json,
        viewport: workflow.viewport || { x: 0, y: 0, zoom: 1 },
        updated_at: new Date().toISOString(),
      };

      let result;
      if (workflow.id || currentWorkflowId) {
        const { data, error } = await supabase
          .from("workflows")
          .update(workflowData)
          .eq("id", workflow.id || currentWorkflowId)
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        result = data;
      } else {
        const { data, error } = await supabase
          .from("workflows")
          .insert(workflowData)
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        result = data;
        setCurrentWorkflowId(result.id);
      }

      toast({ title: "Workflow saved" });
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      return result.id;
    } catch (error: unknown) {
      console.error("Save workflow error:", error);
      toast({ title: "Save failed", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
      return null;
    } finally {
      setIsSaving(false);
    }
  }, [user, currentWorkflowId, toast, queryClient]);

  const loadWorkflow = useCallback(async (workflowId: string): Promise<WorkflowData | null> => {
    if (!user) {
      toast({ title: "Login required", variant: "destructive" });
      return null;
    }

    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("workflows")
        .select("*")
        .eq("id", workflowId)
        .eq("user_id", user.id)
        .single();

      if (error) throw new Error(error.message);
      setCurrentWorkflowId(data.id);
      
      return {
        id: data.id,
        name: data.name,
        description: data.description || undefined,
        nodes: (data.nodes as unknown as Node[]) || [],
        edges: (data.edges as unknown as Edge[]) || [],
        viewport: (data.viewport as WorkflowData["viewport"]) || { x: 0, y: 0, zoom: 1 },
      };
    } catch (error: unknown) {
      console.error("Load workflow error:", error);
      toast({ title: "Load failed", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user, toast]);

  const listWorkflows = useCallback(async () => {
    if (!user) return [];
    try {
      const { data, error } = await supabase
        .from("workflows")
        .select("id, name, description, updated_at, created_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error: unknown) {
      console.error("List workflows error:", error);
      return [];
    }
  }, [user]);

  const executeWorkflow = useCallback(async (
    nodes: Node[],
    edges: Edge[],
    scheduledAt?: Date
  ): Promise<ExecutionResult> => {
    if (!user) {
      toast({ title: "Login required", variant: "destructive" });
      return { success: false, errors: ["Not authenticated"] };
    }

    const quotaCheck = await canCreatePost();
    if (!quotaCheck.allowed) {
      toast({
        title: "Post limit reached",
        description: quotaCheck.message || "You've reached your post quota.",
        variant: "destructive",
      });
      return { success: false, errors: [quotaCheck.message || "Post quota exceeded"] };
    }

    setIsExecuting(true);
    const errors: string[] = [];

    try {
      // Find nodes - support both text_caption and caption (image gen) as caption source
      const textCaptionNode = nodes.find(n => n.type === "text_caption");
      const captionNode = nodes.find(n => n.type === "caption"); // image gen node
      const mediaNode = nodes.find(n => n.type === "media");
      const platformNode = nodes.find(n => n.type === "platform");

      if (!platformNode) {
        throw new Error("No Platform node found. Add a Platform node to publish.");
      }

      const platformData = platformNode.data as PlatformNodeData;
      const selectedAccountIds: string[] = platformData.selectedAccountIds || [];
      const enabledPlatforms: string[] = platformData.enabledPlatforms || [];
      const platformSettings = platformData.settings || {};
      const scheduledTime = scheduledAt || (platformData.scheduledAt ? new Date(platformData.scheduledAt) : null);

      if (selectedAccountIds.length === 0 && enabledPlatforms.length === 0) {
        throw new Error("No accounts selected. Enable at least one platform account.");
      }

      // Get caption from text caption node
      const captionData = textCaptionNode?.data as { caption?: string } | undefined;
      const caption = captionData?.caption || "";

      // Get media files from media node
      const mediaData = mediaNode?.data as { mediaFiles?: { url: string; type: string }[] } | undefined;
      const mediaFiles = mediaData?.mediaFiles || [];

      // Also check image gen node for generated images
      const imageGenData = captionNode?.data as { generatedImage?: unknown } | undefined;
      if (imageGenData?.generatedImage) {
        // Could add generated image to media
      }

      const platforms = enabledPlatforms.length > 0 ? enabledPlatforms : [...new Set(selectedAccountIds.map(() => 'unknown'))];

      // Create media file records
      const mediaFileIds: string[] = [];
      if (mediaFiles.length > 0) {
        for (const media of mediaFiles) {
          const { data: mediaRecord, error } = await supabase
            .from("media_files")
            .insert({
              user_id: user.id,
              file_path: media.url,
              file_type: media.type,
              mime_type: media.type === "video" ? "video/mp4" : "image/jpeg",
            })
            .select("id")
            .single();
          if (error) {
            if (isMediaQuotaMessage(error.message)) {
              // The post is not created: remove the rows this run already added.
              if (mediaFileIds.length > 0) await supabase.from("media_files").delete().in("id", mediaFileIds);
              throw new Error(mediaQuotaHumanMessage(error.message));
            }
            console.error("Media insert error:", error);
          } else if (mediaRecord) {
            mediaFileIds.push(mediaRecord.id);
          }
        }
      }

      // Create the post
      const { data: post, error: postError } = await supabase
        .from("posts")
        .insert({
          user_id: user.id,
          caption,
          platforms: platforms as string[],
          media_file_ids: mediaFileIds.length > 0 ? mediaFileIds : null,
          status: scheduledTime ? "pending" : "processing",
          scheduled_at: scheduledTime?.toISOString() || null,
          metadata: {
            platform_settings: platformSettings,
            source: "canvas",
            selected_account_ids: selectedAccountIds,
          },
        })
        .select("id")
        .single();

      if (postError) throw new Error(postError.message);

      // Create platform_posts entries with social_account_ids
      if (selectedAccountIds.length > 0) {
        // Fetch account details to get platforms
        const { data: accounts } = await supabase
          .from("social_accounts")
          .select("id, platform")
          .in("id", selectedAccountIds);

        for (const account of (accounts || [])) {
          await supabase.from("platform_posts").insert({
            post_id: post.id,
            platform: account.platform,
            social_account_id: account.id,
            status: scheduledTime ? "pending" : "processing",
          });
        }
      } else {
        // Fallback: create without account IDs
        for (const platform of platforms) {
          await supabase.from("platform_posts").insert({
            post_id: post.id,
            platform: platform as string,
            status: scheduledTime ? "pending" : "processing",
          });
        }
      }

      if (scheduledTime) {
        toast({ 
          title: "Post scheduled!", 
          description: `Your post will be published on ${scheduledTime.toLocaleDateString()} at ${scheduledTime.toLocaleTimeString()}.` 
        });
        return { success: true, postId: post.id };
      }

      toast({ title: "Publishing...", description: "Your post is being published." });

      const { data: processResult, error: processError } = await supabase.functions.invoke(
        "process-post",
        { body: { post_id: post.id } }
      );

      if (processError) {
        errors.push(processError.message);
      }

      if (processResult?.results) {
        const failed = processResult.results.filter((r: ProcessPostResult) => !r.success);
        const succeeded = processResult.results.filter((r: ProcessPostResult) => r.success);
        if (failed.length > 0) {
          failed.forEach((f: ProcessPostResult) => errors.push(`${f.platform}: ${f.error}`));
        }
        if (succeeded.length > 0) {
          toast({ title: "Published!", description: `Successfully published to ${succeeded.length} platform(s).` });
        }
      }

      queryClient.invalidateQueries({ queryKey: ["posts"] });
      queryClient.invalidateQueries({ queryKey: ["platform-posts"] });

      return { 
        success: errors.length === 0, 
        postId: post.id,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error: unknown) {
      console.error("Execute workflow error:", error);
      toast({ title: "Execution failed", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
      return { success: false, errors: [error instanceof Error ? error.message : String(error)] };
    } finally {
      setIsExecuting(false);
    }
  }, [user, toast, queryClient, canCreatePost]);

  const createExecution = useCallback(async (
    workflowId: string,
    status: "pending" | "running" | "completed" | "failed",
    summary?: Json,
    errorMessage?: string
  ) => {
    if (!user || !workflowId) return null;
    try {
      const { data, error } = await supabase
        .from("workflow_executions")
        .insert({
          workflow_id: workflowId,
          user_id: user.id,
          status,
          started_at: new Date().toISOString(),
          completed_at: status === "completed" || status === "failed" ? new Date().toISOString() : null,
          execution_summary: summary || {},
          error_message: errorMessage || null,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    } catch (error) {
      console.error("Create execution error:", error);
      return null;
    }
  }, [user]);

  return {
    isSaving,
    isLoading,
    isExecuting,
    currentWorkflowId,
    saveWorkflow,
    loadWorkflow,
    listWorkflows,
    executeWorkflow,
    createExecution,
    setCurrentWorkflowId,
  };
}
