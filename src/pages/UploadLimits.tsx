import { useTranslation, Trans } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Shield, Clock } from "lucide-react";

const platformLimits = [
  { id: "instagram", cap: 50 },
  { id: "tiktok", cap: 15 },
  { id: "linkedin", cap: 150 },
  { id: "youtube", cap: 10 },
  { id: "facebook", cap: 25 },
  { id: "twitter", cap: 50 },
  { id: "pinterest", cap: 20 },
];

export default function UploadLimits() {
  const { t } = useTranslation("billing");
  const platformNames: Record<string, string> = {
    instagram: t("uploadLimits.platforms.instagram", "Instagram"),
    tiktok: t("uploadLimits.platforms.tiktok", "TikTok"),
    linkedin: t("uploadLimits.platforms.linkedin", "LinkedIn"),
    youtube: t("uploadLimits.platforms.youtube", "YouTube"),
    facebook: t("uploadLimits.platforms.facebook", "Facebook"),
    twitter: t("uploadLimits.platforms.twitter", "X (Twitter)"),
    pinterest: t("uploadLimits.platforms.pinterest", "Pinterest"),
  };

  return (
    <DashboardLayout>
      <div className="space-y-8 max-w-4xl">
        <div>
          <h1 className="text-3xl font-bold">{t("uploadLimits.header.title", "Upload Limits")}</h1>
          <p className="text-muted-foreground mt-2">
            {t("uploadLimits.header.subtitle", "Understand the posting limits to protect your accounts and stay compliant.")}
          </p>
        </div>

        {/* Social Hard Caps */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              {t("uploadLimits.caps.title", "Social Hard Caps Per Network")}
            </CardTitle>
            <CardDescription>
              {t("uploadLimits.caps.desc", "To protect your connected accounts and stay compliant with each social network, we enforce platform hard caps using a rolling 24-hour window.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("uploadLimits.table.network", "Social Network")}</TableHead>
                    <TableHead className="text-right">{t("uploadLimits.table.cap", "Hard Cap (posts per 24h)")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {platformLimits.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{platformNames[item.id]}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="secondary">{item.cap}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* How It Works */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-primary" />
              {t("uploadLimits.how.title", "How It Works")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-3 text-sm">
              <li className="flex gap-2">
                <span className="text-primary font-bold">•</span>
                <span>
                  <Trans ns="billing" i18nKey="uploadLimits.how.whatCounts" components={{ strong: <strong /> }}>
                    <strong>What counts:</strong> Only successful publishes recorded for that account/network in the last 24 hours.
                  </Trans>
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary font-bold">•</span>
                <span>
                  <Trans ns="billing" i18nKey="uploadLimits.how.scope" components={{ strong: <strong /> }}>
                    <strong>Scope:</strong> Per connected social account. These limits are NOT global to your user.
                  </Trans>
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary font-bold">•</span>
                <span>
                  <Trans ns="billing" i18nKey="uploadLimits.how.scheduled" components={{ strong: <strong /> }}>
                    <strong>Scheduled posts:</strong> Caps are re-checked at execution time; if the cap is already reached, the publish will be rejected.
                  </Trans>
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* Error Response */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              {t("uploadLimits.reached.title", "When Cap Is Reached")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              {t("uploadLimits.reached.desc", "When a cap is reached, you'll receive a 429 Too Many Requests error:")}
            </p>
            <pre className="bg-muted p-4 rounded-lg text-xs overflow-x-auto">
{`{
  "success": false,
  "message": "Post verification failed",
  "violations": [
    {
      "platform": "instagram",
      "type": "hard_cap",
      "message": "Daily cap reached: 50/50 in last 24h",
      "used_last_24h": 50,
      "cap": 50
    }
  ]
}`}
            </pre>
          </CardContent>
        </Card>

        {/* Additional Checks */}
        <Card>
          <CardHeader>
            <CardTitle>{t("uploadLimits.extra.title", "Additional Content Checks")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>• {t("uploadLimits.extra.duplicate", "Duplicate/similar content within 48h to reduce spam risk")}</li>
              <li>• {t("uploadLimits.extra.mentions", "Mention limits to avoid spammy behavior")}</li>
              <li>• {t("uploadLimits.extra.media", "Media and content sanity checks aligned with network guidelines")}</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
