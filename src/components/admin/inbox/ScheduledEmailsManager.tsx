import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  Clock,
  Mail,
  Trash2,
  Edit,
  Send,
  Loader2,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface ScheduledEmail {
  id: string;
  admin_id: string;
  from_email: string;
  to_email: string;
  cc_email: string | null;
  bcc_email: string | null;
  subject: string;
  html_body: string;
  text_body: string | null;
  scheduled_at: string;
  status: string;
  sent_at: string | null;
  error_message: string | null;
  created_at: string;
}

export function ScheduledEmailsManager() {
  const [emails, setEmails] = useState<ScheduledEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<ScheduledEmail | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [emailToDelete, setEmailToDelete] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    subject: "",
    scheduledAt: "",
    scheduledTime: "",
  });

  const fetchScheduledEmails = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("scheduled_emails")
        .select("*")
        .order("scheduled_at", { ascending: true });

      if (error) throw error;
      setEmails(data || []);
    } catch (error) {
      console.error("Error fetching scheduled emails:", error);
      toast.error("Failed to load scheduled emails");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchScheduledEmails();
  }, []);

  const handleCancelEmail = async (id: string) => {
    try {
      const { error } = await supabase
        .from("scheduled_emails")
        .update({ status: "cancelled" })
        .eq("id", id);

      if (error) throw error;
      toast.success("Email cancelled");
      fetchScheduledEmails();
      setDeleteDialogOpen(false);
      setEmailToDelete(null);
    } catch (error) {
      console.error("Error cancelling email:", error);
      toast.error("Failed to cancel email");
    }
  };

  const handleDeleteEmail = async (id: string) => {
    try {
      const { error } = await supabase
        .from("scheduled_emails")
        .delete()
        .eq("id", id);

      if (error) throw error;
      toast.success("Email deleted");
      fetchScheduledEmails();
      setSelectedEmail(null);
      setDeleteDialogOpen(false);
      setEmailToDelete(null);
    } catch (error) {
      console.error("Error deleting email:", error);
      toast.error("Failed to delete email");
    }
  };

  const handleEditClick = (email: ScheduledEmail) => {
    const scheduledDate = new Date(email.scheduled_at);
    setEditForm({
      subject: email.subject,
      scheduledAt: format(scheduledDate, "yyyy-MM-dd"),
      scheduledTime: format(scheduledDate, "HH:mm"),
    });
    setSelectedEmail(email);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!selectedEmail) return;

    try {
      const newScheduledAt = new Date(
        `${editForm.scheduledAt}T${editForm.scheduledTime}`
      );

      if (newScheduledAt <= new Date()) {
        toast.error("Scheduled time must be in the future");
        return;
      }

      const { error } = await supabase
        .from("scheduled_emails")
        .update({
          subject: editForm.subject,
          scheduled_at: newScheduledAt.toISOString(),
        })
        .eq("id", selectedEmail.id);

      if (error) throw error;
      toast.success("Email updated");
      setEditDialogOpen(false);
      fetchScheduledEmails();
    } catch (error) {
      console.error("Error updating email:", error);
      toast.error("Failed to update email");
    }
  };

  const handleSendNow = async (email: ScheduledEmail) => {
    try {
      const { error } = await supabase
        .from("scheduled_emails")
        .update({
          scheduled_at: new Date().toISOString(),
          status: "pending",
        })
        .eq("id", email.id);

      if (error) throw error;
      toast.success("Email queued for immediate sending");
      fetchScheduledEmails();
    } catch (error) {
      console.error("Error sending email:", error);
      toast.error("Failed to queue email");
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return (
          <Badge variant="secondary" className="gap-1">
            <Clock className="w-3 h-3" />
            Pending
          </Badge>
        );
      case "processing":
        return (
          <Badge className="gap-1 bg-blue-500">
            <Loader2 className="w-3 h-3 animate-spin" />
            Processing
          </Badge>
        );
      case "sent":
        return (
          <Badge className="gap-1 bg-green-500">
            <CheckCircle className="w-3 h-3" />
            Sent
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="w-3 h-3" />
            Failed
          </Badge>
        );
      case "cancelled":
        return (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <AlertCircle className="w-3 h-3" />
            Cancelled
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const pendingEmails = emails.filter((e) => e.status === "pending");
  const processedEmails = emails.filter((e) => e.status !== "pending");

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Scheduled Emails</h3>
          <p className="text-sm text-muted-foreground">
            {pendingEmails.length} pending email{pendingEmails.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchScheduledEmails}>
          <RefreshCw className="w-4 h-4 me-2" />
          Refresh
        </Button>
      </div>

      {/* Pending Emails */}
      {pendingEmails.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Pending Emails
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[300px] max-md:[&>[data-radix-scroll-area-viewport]>div]:!block">
              <div className="divide-y">
                {pendingEmails.map((email) => (
                  <div
                    key={email.id}
                    className="p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span className="font-medium truncate">
                            {email.to_email}
                          </span>
                          {getStatusBadge(email.status)}
                        </div>
                        <p className="text-sm font-medium truncate">
                          {email.subject}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Scheduled for{" "}
                          {format(
                            new Date(email.scheduled_at),
                            "MMM d, yyyy 'at' h:mm a"
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleSendNow(email)}
                          title="Send now"
                        >
                          <Send className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEditClick(email)}
                          title="Edit"
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setEmailToDelete(email.id);
                            setDeleteDialogOpen(true);
                          }}
                          className="text-destructive hover:text-destructive"
                          title="Cancel"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* History */}
      {processedEmails.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              History
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[300px] max-md:[&>[data-radix-scroll-area-viewport]>div]:!block">
              <div className="divide-y">
                {processedEmails.map((email) => (
                  <div
                    key={email.id}
                    className="p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span className="font-medium truncate">
                            {email.to_email}
                          </span>
                          {getStatusBadge(email.status)}
                        </div>
                        <p className="text-sm font-medium truncate">
                          {email.subject}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {email.status === "sent" && email.sent_at
                            ? `Sent ${format(
                                new Date(email.sent_at),
                                "MMM d, yyyy 'at' h:mm a"
                              )}`
                            : email.status === "failed"
                            ? email.error_message || "Failed to send"
                            : `Scheduled for ${format(
                                new Date(email.scheduled_at),
                                "MMM d, yyyy 'at' h:mm a"
                              )}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {email.status === "failed" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleSendNow(email)}
                          >
                            Retry
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteEmail(email.id)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {emails.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Clock className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
            <h3 className="font-medium text-lg mb-1">No scheduled emails</h3>
            <p className="text-sm text-muted-foreground">
              Schedule an email to send later by clicking the clock icon in the
              compose form.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Scheduled Email</DialogTitle>
            <DialogDescription>
              Modify the subject or scheduled time for this email.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                value={editForm.subject}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, subject: e.target.value }))
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="date">Date</Label>
                <Input
                  id="date"
                  type="date"
                  value={editForm.scheduledAt}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      scheduledAt: e.target.value,
                    }))
                  }
                  min={format(new Date(), "yyyy-MM-dd")}
                />
              </div>
              <div>
                <Label htmlFor="time">Time</Label>
                <Input
                  id="time"
                  type="time"
                  value={editForm.scheduledTime}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      scheduledTime: e.target.value,
                    }))
                  }
                />
              </div>
            </div>
            {selectedEmail && (
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">
                  <strong>To:</strong> {selectedEmail.to_email}
                </p>
                <p className="text-sm text-muted-foreground">
                  <strong>From:</strong> {selectedEmail.from_email}
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Scheduled Email?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the scheduled email. The email will not be sent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Scheduled</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => emailToDelete && handleCancelEmail(emailToDelete)}
              className="bg-destructive hover:bg-destructive/90"
            >
              Cancel Email
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
