import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { YouTubeAnalyticsClientError } from "../domain/errors";
import { getAnalyticsPurposeText } from "../domain/purposeText";

function purposeErrorMessage(error: unknown, locale: "en" | "ar"): string {
  const code = error instanceof YouTubeAnalyticsClientError ? error.code : null;
  const ref = error instanceof YouTubeAnalyticsClientError && error.requestId ? ` (${error.requestId})` : "";
  if (code === "consent_version_stale") {
    return (locale === "ar"
      ? "تغيّر نص غرض التحليلات. حدّث الصفحة وراجع النص الجديد قبل السماح."
      : "The analytics purpose text has been updated. Reload the page to review the current text.") + ref;
  }
  if (code === "connection_changed") {
    return (locale === "ar"
      ? "تغيّر اتصال القناة أثناء الطلب. راجع القناة المعروضة واسمح مرة أخرى."
      : "The channel connection changed while this panel was open. Review the channel and try again.") + ref;
  }
  return (locale === "ar"
    ? "تعذر تسجيل الإذن. حاول مرة أخرى."
    : "The permission could not be recorded. Try again.") + ref;
}

export function PurposeAcceptancePanel(props: {
  channelName: string;
  locale: "en" | "ar";
  busy: boolean;
  error?: unknown;
  onAllow: () => void;
}) {
  const { channelName, locale, busy, error, onAllow } = props;
  const text = getAnalyticsPurposeText(locale);
  const [declined, setDeclined] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setDeclined(false);
    headingRef.current?.focus();
  }, [channelName, locale]);

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
      {error ? <p role="alert" className="text-sm text-destructive">{purposeErrorMessage(error, locale)}</p> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" disabled={busy} onClick={onAllow}>{text.allowButton}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setDeclined(true)}>{text.notNowButton}</Button>
      </div>
    </section>
  );
}
