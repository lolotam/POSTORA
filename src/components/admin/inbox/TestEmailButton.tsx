import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  FlaskConical, 
  Loader2, 
  CheckCircle2, 
  XCircle,
  ExternalLink
} from "lucide-react";
import { toast } from "sonner";

interface TestResult {
  success: boolean;
  resendId?: string;
  error?: string;
  timestamp: Date;
}

export function TestEmailButton() {
  const [open, setOpen] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const testMutation = useMutation({
    mutationFn: async (email: string) => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        throw new Error("Not authenticated");
      }

      const response = await supabase.functions.invoke("send-inbox-email", {
        body: {
          to: email,
          from: "admin@postora.cloud",
          subject: "🧪 Postora Email Test",
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 24px;">✅ Email Delivery Test</h1>
              </div>
              <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                  Congratulations! If you're reading this, your email delivery is working correctly.
                </p>
                <div style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #e5e7eb;">
                  <p style="margin: 0; color: #6b7280; font-size: 14px;">
                    <strong>Test Details:</strong><br/>
                    Sent at: ${new Date().toLocaleString()}<br/>
                    From: admin@postora.cloud<br/>
                    To: ${email}
                  </p>
                </div>
                <p style="color: #9ca3af; font-size: 12px; margin: 20px 0 0 0; text-align: center;">
                  This is an automated test email from Postora Admin Inbox.
                </p>
              </div>
            </div>
          `,
          text: `Email Delivery Test\n\nCongratulations! If you're reading this, your email delivery is working correctly.\n\nTest Details:\nSent at: ${new Date().toLocaleString()}\nFrom: admin@postora.cloud\nTo: ${email}\n\nThis is an automated test email from Postora Admin Inbox.`,
        },
      });

      if (response.error) {
        throw new Error(response.error.message || "Failed to send test email");
      }

      return response.data;
    },
    onSuccess: (data) => {
      setTestResult({
        success: true,
        resendId: data?.id,
        timestamp: new Date(),
      });
      toast.success("Test email sent! Check your inbox.");
    },
    onError: (error) => {
      setTestResult({
        success: false,
        error: error.message,
        timestamp: new Date(),
      });
      toast.error(`Test failed: ${error.message}`);
    },
  });

  const handleTest = () => {
    if (!testEmail.trim() || !testEmail.includes("@")) {
      toast.error("Please enter a valid email address");
      return;
    }
    setTestResult(null);
    testMutation.mutate(testEmail);
  };

  const resetAndClose = () => {
    setTestResult(null);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) resetAndClose();
      else setOpen(true);
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FlaskConical className="w-4 h-4 me-2" />
          Test Email
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5" />
            Test Email Delivery
          </DialogTitle>
          <DialogDescription>
            Send a test email to verify your email delivery is working correctly.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="test-email">Recipient Email</Label>
            <Input
              id="test-email"
              type="email"
              placeholder="your.email@example.com"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              disabled={testMutation.isPending}
            />
            <p className="text-xs text-muted-foreground">
              Enter an email address where you can check delivery.
            </p>
          </div>

          {testResult && (
            <div
              className={`p-4 rounded-lg border ${
                testResult.success
                  ? "bg-green-500/10 border-green-500/20"
                  : "bg-red-500/10 border-red-500/20"
              }`}
            >
              <div className="flex items-start gap-3">
                {testResult.success ? (
                  <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <p className={`font-medium ${testResult.success ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                    {testResult.success ? "Test Successful!" : "Test Failed"}
                  </p>
                  {testResult.success ? (
                    <div className="mt-1 space-y-1">
                      <p className="text-sm text-muted-foreground">
                        Email sent successfully. Check your inbox (and spam folder).
                      </p>
                      {testResult.resendId && (
                        <a
                          href={`https://resend.com/emails/${testResult.resendId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          View in Resend Dashboard
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-red-600 dark:text-red-400 mt-1">
                      {testResult.error}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={resetAndClose}>
            Close
          </Button>
          <Button onClick={handleTest} disabled={testMutation.isPending}>
            {testMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <FlaskConical className="w-4 h-4 me-2" />
                Send Test
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
