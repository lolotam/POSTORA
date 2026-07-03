import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWhatsAppAgents, useConversationAssignments, useAssignmentHistory } from "@/hooks/useWhatsAppAgents";
import { useConversations, useMessagingAccounts } from "@/hooks/useMessaging";
import { Users, UserPlus, Circle, Clock, History, ArrowRightLeft, UserMinus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

const statusColors: Record<string, string> = {
  online: "bg-green-500",
  away: "bg-yellow-500",
  offline: "bg-muted-foreground/40",
};

const statusLabels: Record<string, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
};

export function AgentManager({ platform = "whatsapp" }: { platform?: "whatsapp" | "facebook" | "instagram" } = {}) {
  const { agents, agentsLoading, myAgent, registerAgent, updateStatus } = useWhatsAppAgents();
  const { assignments, assignConversation, unassignConversation } = useConversationAssignments();
  const { data: history = [] } = useAssignmentHistory();
  const { accounts } = useMessagingAccounts();
  const account = accounts.find((a) => a.platform === platform);
  const messagingPlatform = platform === "whatsapp" ? "WHATSAPP" : platform === "instagram" ? "INSTAGRAM" : "MESSENGER";
  const { data: conversations = [] } = useConversations(account?.id || null, messagingPlatform, { silent: true });
  // Facebook/Instagram conversations use assignment_key (stable across the inbound webhook and
  // this list) instead of Meta's own conversation id, which isn't present in webhook payloads.
  const conversationKey = (c: { id: string; assignment_key?: string }) => c.assignment_key || c.id;

  const [registerOpen, setRegisterOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");

  const handleRegister = () => {
    if (!displayName.trim()) return;
    registerAgent.mutate({ display_name: displayName }, {
      onSuccess: () => {
        toast.success("Registered as agent");
        setRegisterOpen(false);
        setDisplayName("");
      },
      onError: (e) => toast.error(e.message),
    });
  };

  const handleAssign = () => {
    if (!selectedConversation || !selectedAgent) return;
    assignConversation.mutate(
      { conversationId: selectedConversation, agentId: selectedAgent },
      {
        onSuccess: () => {
          toast.success("Conversation assigned");
          setAssignOpen(false);
          setSelectedConversation("");
          setSelectedAgent("");
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  const handleUnassign = (conversationId: string) => {
    unassignConversation.mutate({ conversationId }, {
      onSuccess: () => toast.success("Conversation unassigned"),
      onError: (e) => toast.error(e.message),
    });
  };

  const getAgentName = (agentId: string | null) => {
    if (!agentId) return "Unknown";
    return agents.find((a) => a.id === agentId)?.display_name || "Unknown";
  };

  const getConversationName = (convId: string) => {
    const conv = conversations.find((c) => conversationKey(c) === convId);
    return conv?.participant_name || convId.slice(0, 20);
  };

  return (
    <div className="space-y-4">
      {/* Agent Status Bar */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <Users className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium">
                {agents.filter((a) => a.status === "online").length} online
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                {agents.filter((a) => a.status === "away").length} away
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                {assignments.length} active assignments
              </span>
            </div>
            <div className="flex items-center gap-2">
              {myAgent ? (
                <Select value={myAgent.status} onValueChange={(v) => updateStatus.mutate(v as "online" | "away" | "offline")}>
                  <SelectTrigger className="w-32">
                    <div className="flex items-center gap-2">
                      <Circle className={`w-2 h-2 fill-current ${statusColors[myAgent.status]}`} />
                      <SelectValue />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="online">
                      <div className="flex items-center gap-2">
                        <Circle className="w-2 h-2 fill-green-500 text-green-500" />
                        Online
                      </div>
                    </SelectItem>
                    <SelectItem value="away">
                      <div className="flex items-center gap-2">
                        <Circle className="w-2 h-2 fill-yellow-500 text-yellow-500" />
                        Away
                      </div>
                    </SelectItem>
                    <SelectItem value="offline">
                      <div className="flex items-center gap-2">
                        <Circle className="w-2 h-2 fill-muted-foreground/40 text-muted-foreground/40" />
                        Offline
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline">
                      <UserPlus className="w-4 h-4 mr-1" />
                      Join as Agent
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Register as Agent</DialogTitle>
                      <DialogDescription>Enter your display name to join the agent team.</DialogDescription>
                    </DialogHeader>
                    <Input
                      placeholder="Display name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                    <DialogFooter>
                      <Button onClick={handleRegister} disabled={registerAgent.isPending || !displayName.trim()}>
                        {registerAgent.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                        Register
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
              <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <ArrowRightLeft className="w-4 h-4 mr-1" />
                    Assign
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Assign Conversation</DialogTitle>
                    <DialogDescription>Select a conversation and agent to assign.</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    <Select value={selectedConversation} onValueChange={setSelectedConversation}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select conversation" />
                      </SelectTrigger>
                      <SelectContent>
                        {conversations.map((c) => (
                          <SelectItem key={c.id} value={conversationKey(c)}>
                            {c.participant_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select agent" />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.filter((a) => a.status !== "offline").map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            <div className="flex items-center gap-2">
                              <Circle className={`w-2 h-2 fill-current ${statusColors[a.status]}`} />
                              {a.display_name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <DialogFooter>
                    <Button onClick={handleAssign} disabled={assignConversation.isPending || !selectedConversation || !selectedAgent}>
                      {assignConversation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                      Assign
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="agents">
        <TabsList>
          <TabsTrigger value="agents" className="gap-1.5">
            <Users className="w-4 h-4" />
            Agents
          </TabsTrigger>
          <TabsTrigger value="assignments" className="gap-1.5">
            <ArrowRightLeft className="w-4 h-4" />
            Assignments
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History className="w-4 h-4" />
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-4">
          {agentsLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : agents.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <Users className="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p>No agents registered yet. Click "Join as Agent" to get started.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => {
                const agentAssignments = assignments.filter((a) => a.agent_id === agent.id);
                return (
                  <Card key={agent.id}>
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <Avatar className="h-10 w-10">
                            <AvatarImage src={agent.avatar_url || undefined} />
                            <AvatarFallback>{agent.display_name.slice(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-background ${statusColors[agent.status]}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{agent.display_name}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{statusLabels[agent.status]}</span>
                            <span>·</span>
                            <span>{agentAssignments.length} chats</span>
                          </div>
                        </div>
                      </div>
                      {agent.status !== "offline" && (
                        <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          Last seen {formatDistanceToNow(new Date(agent.last_seen_at), { addSuffix: true })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="assignments" className="mt-4">
          {assignments.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <ArrowRightLeft className="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p>No active assignments. Use the Assign button to route conversations to agents.</p>
              </CardContent>
            </Card>
          ) : (
            <ScrollArea className="max-h-[500px]">
              <div className="space-y-2">
                {assignments.map((assignment) => (
                  <Card key={assignment.id}>
                    <CardContent className="py-3 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{getConversationName(assignment.conversation_id)}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                          <span>Assigned to <strong>{getAgentName(assignment.agent_id)}</strong></span>
                          <span>·</span>
                          <span>{formatDistanceToNow(new Date(assignment.assigned_at), { addSuffix: true })}</span>
                        </div>
                        {assignment.notes && (
                          <p className="text-xs text-muted-foreground mt-1 italic">"{assignment.notes}"</p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUnassign(assignment.conversation_id)}
                        disabled={unassignConversation.isPending}
                      >
                        <UserMinus className="w-4 h-4" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </ScrollArea>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          {history.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <History className="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p>No assignment history yet.</p>
              </CardContent>
            </Card>
          ) : (
            <ScrollArea className="max-h-[500px]">
              <div className="space-y-2">
                {history.map((entry) => (
                  <Card key={entry.id}>
                    <CardContent className="py-3">
                      <div className="flex items-center gap-2">
                        <Badge variant={entry.action === "assigned" ? "default" : entry.action === "transferred" ? "secondary" : "outline"}>
                          {entry.action}
                        </Badge>
                        <span className="text-sm font-medium">{getConversationName(entry.conversation_id)}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {entry.action === "transferred" && (
                          <span>{getAgentName(entry.from_agent_id)} → {getAgentName(entry.to_agent_id)}</span>
                        )}
                        {entry.action === "assigned" && (
                          <span>→ {getAgentName(entry.to_agent_id)}</span>
                        )}
                        {entry.action === "unassigned" && (
                          <span>{getAgentName(entry.from_agent_id)} removed</span>
                        )}
                        <span className="ml-2">{formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}</span>
                      </div>
                      {entry.reason && <p className="text-xs italic text-muted-foreground mt-1">Reason: {entry.reason}</p>}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </ScrollArea>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
