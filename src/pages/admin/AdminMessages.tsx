import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, MessageSquare, Send, Check, Clock, AlertCircle, Mail, Phone } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";

interface SupportMessage {
  id: string;
  user_id: string;
  email: string | null;
  mobile: string | null;
  subject: string;
  message: string;
  status: string;
  admin_reply: string | null;
  replied_at: string | null;
  created_at: string;
  profile?: {
    email: string;
    full_name: string | null;
    avatar_url: string | null;
  };
}

export default function AdminMessages() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedMessage, setSelectedMessage] = useState<SupportMessage | null>(null);
  const [replyText, setReplyText] = useState("");

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ["admin-messages"],
    queryFn: async (): Promise<SupportMessage[]> => {
      // Fetch messages
      const { data: messagesData, error: messagesError } = await supabase
        .from("support_messages")
        .select("*")
        .order("created_at", { ascending: false });

      if (messagesError) throw messagesError;
      if (!messagesData || messagesData.length === 0) return [];

      // Get unique user IDs
      const userIds = [...new Set(messagesData.map((m: any) => m.user_id))];

      // Fetch profile data for those users
      const { data: profilesData, error: profilesError } = await supabase
        .from("profiles")
        .select("id, email, full_name, avatar_url")
        .in("id", userIds);

      if (profilesError) {
        console.error("Error fetching profiles:", profilesError);
      }

      // Create a map of user_id to profile
      const profilesMap = new Map(
        (profilesData || []).map((p: any) => [p.id, p])
      );

      // Combine messages with profiles
      return messagesData.map((m: any) => ({
        ...m,
        profile: profilesMap.get(m.user_id) || null,
      }));
    },
  });

  const replyMutation = useMutation({
    mutationFn: async ({ id, reply }: { id: string; reply: string }) => {
      const { error } = await supabase
        .from("support_messages")
        .update({
          admin_reply: reply,
          replied_at: new Date().toISOString(),
          replied_by: user?.id,
          status: "resolved",
        })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-messages"] });
      toast({ title: "Reply sent" });
      setSelectedMessage(null);
      setReplyText("");
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to send reply",
        variant: "destructive",
      });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase
        .from("support_messages")
        .update({ status })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-messages"] });
    },
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "open":
        return <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/30"><Clock className="w-3 h-3 me-1" />Open</Badge>;
      case "in_progress":
        return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/30"><AlertCircle className="w-3 h-3 me-1" />In Progress</Badge>;
      case "resolved":
        return <Badge className="bg-green-500/10 text-green-600 border-green-500/30"><Check className="w-3 h-3 me-1" />Resolved</Badge>;
      case "closed":
        return <Badge variant="secondary">Closed</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const openMessages = messages.filter((m) => m.status === "open");
  const otherMessages = messages.filter((m) => m.status !== "open");

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Support Messages</h2>
          <p className="text-muted-foreground">View and reply to user messages</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <MessageSquare className="w-12 h-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No support messages yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Open Messages */}
            {openMessages.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/30">
                    {openMessages.length}
                  </Badge>
                  Open Messages
                </h3>
                <div className="grid gap-4">
                  {openMessages.map((message) => (
                    <Card key={message.id} className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setSelectedMessage(message)}>
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <Avatar className="shrink-0">
                              <AvatarImage src={message.profile?.avatar_url || undefined} />
                              <AvatarFallback>
                                {message.profile?.full_name?.charAt(0) || message.profile?.email?.charAt(0) || "U"}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <CardTitle className="text-base">{message.subject}</CardTitle>
                              <CardDescription>
                                {message.profile?.full_name || message.profile?.email} • {format(new Date(message.created_at), "MMM d, yyyy")}
                              </CardDescription>
                            </div>
                          </div>
                          {getStatusBadge(message.status)}
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-muted-foreground line-clamp-2">{message.message}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Other Messages */}
            {otherMessages.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Previous Messages</h3>
                <div className="grid gap-4">
                  {otherMessages.map((message) => (
                    <Card key={message.id} className="cursor-pointer hover:bg-muted/50 transition-colors opacity-75" onClick={() => setSelectedMessage(message)}>
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <Avatar className="w-8 h-8 shrink-0">
                              <AvatarImage src={message.profile?.avatar_url || undefined} />
                              <AvatarFallback className="text-xs">
                                {message.profile?.full_name?.charAt(0) || "U"}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <CardTitle className="text-sm">{message.subject}</CardTitle>
                              <CardDescription className="text-xs">
                                {format(new Date(message.created_at), "MMM d, yyyy")}
                              </CardDescription>
                            </div>
                          </div>
                          {getStatusBadge(message.status)}
                        </div>
                      </CardHeader>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Message Detail Dialog */}
      <Dialog open={!!selectedMessage} onOpenChange={() => setSelectedMessage(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedMessage?.subject}</DialogTitle>
            <DialogDescription>
              From {selectedMessage?.profile?.full_name || selectedMessage?.profile?.email} •{" "}
              {selectedMessage && format(new Date(selectedMessage.created_at), "MMM d, yyyy 'at' h:mm a")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Contact Info */}
            {(selectedMessage?.email || selectedMessage?.mobile) && (
              <div className="flex flex-wrap gap-4 text-sm">
                {selectedMessage?.email && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Mail className="w-4 h-4" />
                    <a href={`mailto:${selectedMessage.email}`} className="hover:text-foreground hover:underline break-all">
                      {selectedMessage.email}
                    </a>
                  </div>
                )}
                {selectedMessage?.mobile && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Phone className="w-4 h-4" />
                    <a href={`tel:${selectedMessage.mobile}`} className="hover:text-foreground hover:underline">
                      {selectedMessage.mobile}
                    </a>
                  </div>
                )}
              </div>
            )}

            <div className="bg-muted/50 rounded-lg p-4">
              <p className="text-sm whitespace-pre-wrap">{selectedMessage?.message}</p>
            </div>

            {selectedMessage?.admin_reply && (
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-4">
                <p className="text-xs text-primary font-medium mb-2">Your Reply</p>
                <p className="text-sm whitespace-pre-wrap">{selectedMessage.admin_reply}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  Sent {selectedMessage.replied_at && format(new Date(selectedMessage.replied_at), "MMM d, yyyy 'at' h:mm a")}
                </p>
              </div>
            )}

            {!selectedMessage?.admin_reply && (
              <div className="space-y-2">
                <Textarea
                  placeholder="Type your reply..."
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  rows={4}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {selectedMessage?.status !== "closed" && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (selectedMessage) {
                      updateStatusMutation.mutate({ id: selectedMessage.id, status: "closed" });
                      setSelectedMessage(null);
                    }
                  }}
                >
                  Close Ticket
                </Button>
              )}
              {!selectedMessage?.admin_reply && (
                <Button
                  onClick={() => {
                    if (selectedMessage && replyText.trim()) {
                      replyMutation.mutate({ id: selectedMessage.id, reply: replyText });
                    }
                  }}
                  disabled={!replyText.trim() || replyMutation.isPending}
                >
                  {replyMutation.isPending ? (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 me-2" />
                  )}
                  Send Reply
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
