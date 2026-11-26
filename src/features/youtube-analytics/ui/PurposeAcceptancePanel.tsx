import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { YouTubeAnalyticsClientError } from "../domain/errors";
import { getAnalyticsPurposeText } from "../domain/purposeText";

export function PurposeAcceptancePanel(props: {
  channelName: string;
  locale: "en" | "ar";
  busy: boolean;
  error?: unknown;
  onAllow: () => void;
}) {
  const { channelName, locale, busy, error, onAllow } = props;
  const { t } = useTranslation("analytics");
  const text = getAnalyticsPurposeText(locale);
  const [declined, setDeclined] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setDeclined(false);
    headingRef.current?.focus();
  }, [channelName, locale]);

  const errorCode = error instanceof YouTubeAnalyticsClientError ? error.code : null;
  const errorRef = error instanceof YouTubeAnalyticsClientError && error.requestId ? ` (${error.requestId})` : "";
  const errorMessage = errorCode === "consent_version_stale"
    ? t("youtube.notices.consent_version_stale", "The analytics purpose text has been updated. Reload the page to review the current text.") + errorRef
    : errorCode === "connection_changed"
      ? t("youtube.notices.connection_changed", "The channel connection changed while this panel was open. Review the channel and try again.") + errorRef
      : t("youtube.notices.consent_record_failed", "The permission could not be recorded. Try again.") + errorRef;

  return (
    <section aria-labelledby="analytics-purpose-heading" className="space-y-4 rounded-lg border bg-card p-5" dir={locale === "ar" ? "rtl" : "ltr"}>
      <h2 id="analytics-purpose-heading" ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none" data-purpose-element="channelHeading">
        {text.channelHeading.replace("{{channel}}", channelName)}
      </h2>
      <ul className="list-disc space-y-2 ps-5 text-sm leading-6">
        <li data-purpose-element="whatWeRead">{text.whatWeRead}</li>
        <li data-purpose-element="whyWeRead">{text.whyWeRead}</li>
        <li data-purpose-element="whoSeesIt">{text.whoSeesIt}</li>
        <li data-purpose-element="onDemandNoStorage">{text.onDemandNoStorage}</li>
        <li data-purpose-element="separateFromGoogle">{text.separateFromGoogle}</li>
        <li data-purpose-element="howToStop">{text.howToStop}</li>
      </ul>
      <p className="text-xs text-muted-foreground" data-purpose-element="versionAndLinks">
        {text.versionAndLinks}
      </p>
      <div className="flex gap-3 text-sm">
        <Link className="text-primary underline" to="/privacy">{text.privacyLink}</Link>
        <Link className="text-primary underline" to="/google-api-disclosure">{text.disclosureLink}</Link>
      </div>
      {declined ? <p role="status" className="text-sm text-muted-foreground">{text.declinedNotice}</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{errorMessage}</p> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" disabled={busy} onClick={onAllow}>{text.allowButton}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setDeclined(true)}>{text.notNowButton}</Button>
      </div>
    </section>
  );
}
