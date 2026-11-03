import i18next from "i18next";
import { describe, expect, it } from "vitest";
import analytics from "../locales/ar/analytics.json";
import { ANALYTICS_PERIOD_DAYS } from "../../../supabase/functions/_shared/analyticsCalendar";

/** The period label carries the number after a colon, so it is grammatical for 7, 14, 30 and 90 alike (no plural form is needed). */
describe("owned analytics period label in Arabic", () => {
  const label = (days: number) => `الأيام المكتملة الأخيرة: ${days}`;

  it.each(ANALYTICS_PERIOD_DAYS)("reads correctly for a %s day period", async (days) => {
    const instance = i18next.createInstance();
    await instance.init({ lng: "ar", fallbackLng: false, resources: { ar: { analytics } }, interpolation: { escapeValue: false } });
    expect(instance.t("owned.days", { ns: "analytics", days })).toBe(label(days));
  });
});
