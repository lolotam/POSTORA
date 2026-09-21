import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Send, Mail, MessageSquare, CheckCircle2, Phone } from "lucide-react";

export default function Contact() {
  const { t } = useTranslation("billing");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();

  // Pre-fill email from user profile
  useState(() => {
    if (user?.email) {
      setEmail(user.email);
    }
  });

  const validateEmail = (email: string) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user) {
      toast({
        title: t("contact.toast.notAuthenticated", "Not authenticated"),
        description: t("contact.toast.notAuthenticatedDesc", "Please log in to send a message."),
        variant: "destructive",
      });
      return;
    }

    if (!email.trim() || !validateEmail(email.trim())) {
      toast({
        title: t("contact.toast.invalidEmail", "Invalid email"),
        description: t("contact.toast.invalidEmailDesc", "Please enter a valid email address."),
        variant: "destructive",
      });
      return;
    }

    if (!subject.trim() || !message.trim()) {
      toast({
        title: t("contact.toast.missingFields", "Missing fields"),
        description: t("contact.toast.missingFieldsDesc", "Please fill in both subject and message."),
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const { error } = await supabase
        .from("support_messages")
        .insert({
          user_id: user.id,
          email: email.trim(),
          mobile: mobile.trim() || null,
          subject: subject.trim(),
          message: message.trim(),
        });

      if (error) throw error;

      setSubmitted(true);
      toast({
        title: t("contact.toast.sent", "Message sent!"),
        description: t("contact.toast.sentDesc", "We'll get back to you as soon as possible."),
      });
    } catch (error) {
      console.error("Error sending message:", error);
      toast({
        title: t("contact.toast.failed", "Failed to send"),
        description: error instanceof Error ? error.message : t("contact.toast.failedDesc", "Something went wrong."),
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendAnother = () => {
    setSubmitted(false);
    setSubject("");
    setMessage("");
  };

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Mail className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-3xl font-bold">{t("contact.header.title", "Contact Us")}</h1>
          <p className="text-muted-foreground mt-2">
            {t("contact.header.subtitle", "Have a question, feedback, or need help? Send us a message and we'll respond as soon as possible.")}
          </p>
        </div>

        {submitted ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
            </div>
            <h2 className="text-xl font-semibold mb-2">{t("contact.success.title", "Message Sent!")}</h2>
            <p className="text-muted-foreground mb-6">
              {t("contact.success.desc", "Thank you for reaching out. We've received your message and will get back to you shortly.")}
            </p>
            <Button onClick={handleSendAnother} variant="outline">
              <MessageSquare className="w-4 h-4 mr-2" />
              {t("contact.actions.sendAnother", "Send Another Message")}
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="rounded-xl border border-border bg-card p-6 space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="email">
                    {t("contact.form.email", "Email")} <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      placeholder={t("contact.form.emailPlaceholder", "your@email.com")}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={isSubmitting}
                      className="pl-9"
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mobile">
                    {t("contact.form.mobile", "Mobile")} <span className="text-muted-foreground text-xs">{t("contact.form.optional", "(optional)")}</span>
                  </Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="mobile"
                      type="tel"
                      placeholder={t("contact.form.mobilePlaceholder", "+1 234 567 8900")}
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value)}
                      disabled={isSubmitting}
                      className="pl-9"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="subject">
                  {t("contact.form.subject", "Subject")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="subject"
                  placeholder={t("contact.form.subjectPlaceholder", "What's this about?")}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  disabled={isSubmitting}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="message">
                  {t("contact.form.message", "Message")} <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="message"
                  placeholder={t("contact.form.messagePlaceholder", "Tell us more...")}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={6}
                  disabled={isSubmitting}
                  className="resize-none"
                  required
                />
              </div>
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting || !email.trim() || !subject.trim() || !message.trim()}
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Send className="w-4 h-4 mr-2" />
              )}
              {isSubmitting ? t("contact.actions.sending", "Sending...") : t("contact.actions.send", "Send Message")}
            </Button>
          </form>
        )}

        {/* Additional info */}
        <div className="text-center text-sm text-muted-foreground">
          <p>{t("contact.footer.previousMessages", "You can also view your previous messages in your account settings.")}</p>
        </div>
      </div>
    </DashboardLayout>
  );
}
