import { AdminLayout } from "@/components/admin/AdminLayout";
import { AdminInbox as AdminInboxComponent } from "@/components/admin/inbox/AdminInbox";

export default function AdminInbox() {
  return (
    <AdminLayout>
      {/* h-full + min-h-0 all the way down, or the panels below fall back to
          content height and the inbox stops reaching the bottom of the page. */}
      <div className="h-full flex flex-col gap-6 min-h-0">
        <div className="shrink-0">
          <h1 className="text-2xl font-bold">Email Inbox</h1>
          <p className="text-muted-foreground">
            View and respond to emails sent to admin@postora.cloud and support@postora.cloud
          </p>
        </div>

        <div className="flex-1 min-h-0">
          <AdminInboxComponent />
        </div>
      </div>
    </AdminLayout>
  );
}
