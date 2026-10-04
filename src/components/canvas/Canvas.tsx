import { useCallback, useRef, useState, useEffect } from "react";
import { Type, Image as ImageIcon, Share2, Sparkles } from "lucide-react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Node,
  Edge,
  useReactFlow,
  ReactFlowProvider,
  Panel,
  ConnectionLineType,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { NodeLibrary } from "./NodeLibrary";
import { CanvasToolbar } from "./CanvasToolbar";
import { CaptionNode } from "./nodes/CaptionNode";
import { MediaNode } from "./nodes/MediaNode";
import { PlatformNode } from "./nodes/PlatformNode";
import { TextCaptionNode } from "./nodes/TextCaptionNode";
import DeletableEdge from "./edges/DeletableEdge";
import { DeleteNodeDialog } from "./DeleteNodeDialog";
import { WorkflowListDrawer } from "./WorkflowListDrawer";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { getNodeTypeDefinition, VALID_CONNECTIONS } from "@/lib/canvas/nodeTypes";
import { useToast } from "@/hooks/use-toast";
import { useCanvasWorkflow } from "@/hooks/useCanvasWorkflow";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSearchParams } from "react-router-dom";
import { useDebouncedCallback } from "@/hooks/shared";
import { Icon3D } from "@/components/fx/Icon3D";
import { Reveal } from "@/components/fx/Reveal";

// Custom node types mapping
const nodeTypes = { 
  caption: CaptionNode,
  media: MediaNode,
  platform: PlatformNode,
  text_caption: TextCaptionNode,
};

// Custom edge types mapping
const edgeTypes = {
  deletable: DeletableEdge,
};

// Edge options using CSS variable fallback
const EDGE_COLOR = 'hsl(250 85% 60%)';
const defaultEdgeOptions = {
  type: 'deletable',
  animated: true,
  style: { 
    strokeWidth: 2,
    stroke: EDGE_COLOR,
  },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 14,
    height: 14,
    color: EDGE_COLOR,
  },
};

function CanvasInner() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [workflowName, setWorkflowName] = useState("Untitled Workflow");
  const { toast } = useToast();
  const { getViewport, fitView, zoomIn, zoomOut, setViewport } = useReactFlow();
  const [searchParams] = useSearchParams();
  const [showWorkflowList, setShowWorkflowList] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  
  const {
    isSaving,
    isLoading,
    isExecuting,
    currentWorkflowId,
    saveWorkflow,
    loadWorkflow,
    executeWorkflow,
    setCurrentWorkflowId,
  } = useCanvasWorkflow();

  // Refs to always access current nodes/edges (avoids stale closures)
  const nodesRef = useRef<Node[]>(nodes);
  const edgesRef = useRef<Edge[]>(edges);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  const [history, setHistory] = useState<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  
  // Delete confirmation dialog state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);

  // Load workflow from URL params
  useEffect(() => {
    const workflowId = searchParams.get("id");
    if (workflowId && !currentWorkflowId) {
      loadWorkflow(workflowId).then((data) => {
        if (data) {
          setNodes(data.nodes);
          setEdges(data.edges);
          setWorkflowName(data.name);
          if (data.viewport) {
            setViewport(data.viewport);
          }
          setHasUnsavedChanges(false);
        }
      });
    }
  }, [searchParams, currentWorkflowId, loadWorkflow, setNodes, setEdges, setViewport]);

  // Track unsaved changes
  useEffect(() => {
    if (nodes.length > 0 || edges.length > 0) {
      setHasUnsavedChanges(true);
    }
  }, [nodes, edges]);

  // Auto-save (only if workflow was previously saved)
  const debouncedAutoSave = useDebouncedCallback(async () => {
    if (!currentWorkflowId || isSaving) return;
    const viewport = getViewport();
    await saveWorkflow({
      id: currentWorkflowId,
      name: workflowName,
      nodes,
      edges,
      viewport,
    });
    setHasUnsavedChanges(false);
  }, 5000);

  useEffect(() => {
    if (currentWorkflowId && hasUnsavedChanges) {
      debouncedAutoSave();
    }
  }, [nodes, edges, currentWorkflowId, hasUnsavedChanges]);

  const saveToHistory = useCallback(() => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push({ nodes: [...nodes], edges: [...edges] });
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }, [nodes, edges, history, historyIndex]);

  // Connection validation
  const isValidConnection = useCallback((connection: Connection) => {
    // Prevent self-connections
    if (connection.source === connection.target) return false;
    
    // Prevent duplicate connections
    const existingEdge = edges.find(
      e => e.source === connection.source && e.target === connection.target &&
           e.sourceHandle === connection.sourceHandle && e.targetHandle === connection.targetHandle
    );
    if (existingEdge) return false;

    // Validate handle types
    const sourceHandle = connection.sourceHandle || '';
    const targetHandle = connection.targetHandle || '';
    const validTargets = VALID_CONNECTIONS[sourceHandle];
    if (validTargets && !validTargets.includes(targetHandle)) return false;

    return true;
  }, [edges]);

  const onConnect = useCallback(
    (params: Connection) => {
      saveToHistory();
      setEdges((eds) => addEdge({ 
        ...params, 
        ...defaultEdgeOptions,
      }, eds));
    },
    [setEdges, saveToHistory]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/reactflow");
      if (!type || !reactFlowWrapper.current) return;

      const nodeDefinition = getNodeTypeDefinition(type);
      if (!nodeDefinition) return;

      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const viewport = getViewport();
      const position = {
        x: (event.clientX - bounds.left - viewport.x) / viewport.zoom,
        y: (event.clientY - bounds.top - viewport.y) / viewport.zoom,
      };

      saveToHistory();

      const newNode: Node = {
        id: `${type}-${Date.now()}`,
        type: type,
        position,
        data: { 
          type, 
          label: nodeDefinition.label, 
          config: {},
          onPublish: () => handleRun(),
          onSchedule: (date: Date) => {
            toast({ 
              title: "Schedule set", 
              description: `Post will be published on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}` 
            });
          },
        },
      };

      setNodes((nds) => [...nds, newNode]);
      toast({ title: "Node added", description: `${nodeDefinition.label} added to canvas` });
    },
    [getViewport, setNodes, saveToHistory, toast]
  );

  const onDragStart = useCallback((event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  }, []);

  // Save workflow
  const handleSave = useCallback(async () => {
    const viewport = getViewport();
    await saveWorkflow({
      id: currentWorkflowId || undefined,
      name: workflowName,
      nodes,
      edges,
      viewport,
    });
    setHasUnsavedChanges(false);
  }, [saveWorkflow, currentWorkflowId, workflowName, nodes, edges, getViewport]);

  // Execute workflow
  const handleRun = useCallback(async () => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;

    if (currentNodes.length === 0) {
      toast({ title: "Cannot run", description: "Add some nodes first.", variant: "destructive" });
      return;
    }

    const platformNode = currentNodes.find(n => n.type === "platform");
    if (!platformNode) {
      toast({ 
        title: "Missing Platform node", 
        description: "Add a Platform node to publish your post.", 
        variant: "destructive" 
      });
      return;
    }

    const platformData = platformNode.data as any;
    const scheduledAt = platformData?.scheduledAt ? new Date(platformData.scheduledAt) : undefined;

    const result = await executeWorkflow(currentNodes, currentEdges, scheduledAt);

    if (result.errors && result.errors.length > 0) {
      toast({ 
        title: "Some platforms failed", 
        description: result.errors.join(", "),
        variant: "destructive" 
      });
    }
  }, [executeWorkflow, toast]);

  // Load a workflow
  const handleLoadWorkflow = useCallback(async (workflowId: string) => {
    const data = await loadWorkflow(workflowId);
    if (data) {
      setNodes(data.nodes);
      setEdges(data.edges);
      setWorkflowName(data.name);
      if (data.viewport) setViewport(data.viewport);
      setHasUnsavedChanges(false);
    }
  }, [loadWorkflow, setNodes, setEdges, setViewport]);

  const handleNewWorkflow = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setCurrentWorkflowId(null);
    setWorkflowName("Untitled Workflow");
    setHasUnsavedChanges(false);
  }, [setNodes, setEdges, setCurrentWorkflowId]);

  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const prevState = history[historyIndex - 1];
      setNodes(prevState.nodes);
      setEdges(prevState.edges);
      setHistoryIndex(historyIndex - 1);
    }
  }, [history, historyIndex, setNodes, setEdges]);

  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextState = history[historyIndex + 1];
      setNodes(nextState.nodes);
      setEdges(nextState.edges);
      setHistoryIndex(historyIndex + 1);
    }
  }, [history, historyIndex, setNodes, setEdges]);

  const handleClear = useCallback(() => {
    saveToHistory();
    setNodes([]);
    setEdges([]);
    setCurrentWorkflowId(null);
    setWorkflowName("Untitled Workflow");
    toast({ title: "Canvas cleared" });
  }, [setNodes, setEdges, saveToHistory, setCurrentWorkflowId, toast]);

  // Handle delete with confirmation
  const requestDeleteNodes = useCallback((nodeIds: string[]) => {
    if (nodeIds.length === 0) return;
    setPendingDeleteIds(nodeIds);
    setShowDeleteDialog(true);
  }, []);

  const confirmDelete = useCallback(() => {
    saveToHistory();
    setNodes((nodes) => nodes.filter((n) => !pendingDeleteIds.includes(n.id)));
    setEdges((edges) => edges.filter(
      (e) => !pendingDeleteIds.includes(e.source) && !pendingDeleteIds.includes(e.target)
    ));
    setShowDeleteDialog(false);
    setPendingDeleteIds([]);
    toast({ 
      title: pendingDeleteIds.length > 1 ? "Nodes deleted" : "Node deleted",
      description: `${pendingDeleteIds.length} node${pendingDeleteIds.length > 1 ? 's' : ''} removed`
    });
  }, [pendingDeleteIds, setNodes, setEdges, saveToHistory, toast]);

  const cancelDelete = useCallback(() => {
    setShowDeleteDialog(false);
    setPendingDeleteIds([]);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const selectedNodes = nodes.filter(n => n.selected);
        if (selectedNodes.length > 0) {
          e.preventDefault();
          requestDeleteNodes(selectedNodes.map(n => n.id));
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, handleUndo, handleRedo, nodes, requestDeleteNodes]);

  const viewport = getViewport();

  return (
    <TooltipProvider>
      <div className="flex h-full w-full bg-background relative">
        <div ref={reactFlowWrapper} className="flex-1 relative">
          {/* Background halos for depth */}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            connectionLineType={ConnectionLineType.Bezier}
            connectionLineStyle={{ stroke: EDGE_COLOR, strokeWidth: 2 }}
            isValidConnection={isValidConnection}
            fitView
            snapToGrid
            snapGrid={[24, 24]}
            className="!bg-[hsl(var(--canvas-bg,225_30%_4%))] relative z-[1]"
            proOptions={{ hideAttribution: true }}
          >
            <Background 
              variant={BackgroundVariant.Dots} 
              gap={24} 
              size={1} 
              color="hsl(var(--muted-foreground) / 0.12)"
            />
            <Controls 
              className="!bg-card !border !border-border !rounded-lg !shadow-md" 
              showInteractive={false} 
            />
            <MiniMap 
              className="!bg-card !border !border-border !rounded-lg !shadow-md" 
              maskColor="hsl(var(--canvas-bg, 225 30% 4%) / 0.85)"
              nodeColor={(node) => {
                if (node.type === 'text_caption') return 'hsl(220 90% 56%)';
                if (node.type === 'caption') return 'hsl(38 92% 50%)';
                if (node.type === 'media') return 'hsl(270 90% 56%)';
                if (node.type === 'platform') return 'hsl(150 80% 45%)';
                return 'hsl(var(--muted))';
              }}
            />
            
            {/* Empty State */}
            {nodes.length === 0 && (
              <Panel position="top-center" className="mt-32">
                <Reveal>
                  <div className="group relative max-w-md">
                    <div className="relative text-center p-8 rounded-3xl bg-card ring-1 ring-white/10 shadow-2xl">
                      <div className="flex justify-center gap-3 mb-6">
                        <Icon3D icon={Type} variant="sky" size="sm" />
                        <Icon3D icon={ImageIcon} variant="violet" size="sm" />
                        <Icon3D icon={Share2} variant="emerald" size="sm" />
                      </div>
                      <div className="inline-flex items-center gap-2 mb-3 px-3 py-1 rounded-full bg-white/5 ring-1 ring-white/10">
                        <Sparkles className="h-3 w-3 text-violet-400" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground">
                          Visual Builder
                        </span>
                      </div>
                      <h3 className="text-2xl font-bold mb-2 text-foreground">
                        Build Your Post Workflow
                      </h3>
                      <p className="text-sm text-muted-foreground mb-5">
                        Drag <span className="text-sky-400 font-medium">Caption</span>,
                        <span className="text-violet-400 font-medium"> Media</span>, and
                        <span className="text-emerald-400 font-medium"> Platform</span> nodes to create your post.
                      </p>
                      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                        <kbd className="px-2 py-1 bg-white/5 ring-1 ring-white/10 rounded text-[10px] font-mono">Space</kbd>
                        <span>+ drag to pan</span>
                        <span className="mx-2 opacity-50">•</span>
                        <kbd className="px-2 py-1 bg-white/5 ring-1 ring-white/10 rounded text-[10px] font-mono">Scroll</kbd>
                        <span>to zoom</span>
                      </div>
                    </div>
                  </div>
                </Reveal>
              </Panel>
            )}
          </ReactFlow>

          {/* Node Library */}
          <NodeLibrary onDragStart={onDragStart} />

          {/* Toolbar */}
          <CanvasToolbar
            workflowName={workflowName}
            onWorkflowNameChange={setWorkflowName}
            onSave={handleSave}
            onRun={handleRun}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onZoomIn={() => zoomIn()}
            onZoomOut={() => zoomOut()}
            onFitView={() => fitView({ padding: 0.2 })}
            onClear={handleClear}
            onShowWorkflows={() => setShowWorkflowList(true)}
            onShowShortcuts={() => setShowShortcuts(true)}
            canUndo={historyIndex > 0}
            canRedo={historyIndex < history.length - 1}
            zoom={viewport.zoom}
            nodeCount={nodes.length}
            isSaving={isSaving}
            isRunning={isExecuting}
            hasUnsavedChanges={hasUnsavedChanges}
          />

          {/* Delete Confirmation Dialog */}
          <DeleteNodeDialog
            open={showDeleteDialog}
            nodeCount={pendingDeleteIds.length}
            onConfirm={confirmDelete}
            onCancel={cancelDelete}
          />

          {/* Workflow List Drawer */}
          <WorkflowListDrawer
            open={showWorkflowList}
            onOpenChange={setShowWorkflowList}
            onLoad={handleLoadWorkflow}
            onNew={handleNewWorkflow}
            currentWorkflowId={currentWorkflowId}
          />

          {/* Keyboard Shortcuts Dialog */}
          <KeyboardShortcutsDialog
            open={showShortcuts}
            onOpenChange={setShowShortcuts}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
