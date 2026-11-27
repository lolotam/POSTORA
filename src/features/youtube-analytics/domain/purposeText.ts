import { ANALYTICS_PURPOSE_VERSION } from "./types";

export const ANALYTICS_PURPOSE_CLAUSE_DATE = "2026-11-26";

export const ANALYTICS_PURPOSE_TEXT = {
  1: {
    en: {
      channelHeading: "Allow YouTube Analytics for {{channel}}?",
      whatWeRead: "Postora will read views, watch time, average view duration, subscribers gained and lost, likes, comments, and shares for this channel and each video from YouTube Analytics.",
      whyWeRead: "These numbers are used solely to display them to you, the channel owner, inside Postora. Postora uses them for no other purpose.",
      whoSeesIt: "Only you, the signed-in channel owner, can see these numbers.",
      onDemandNoStorage: "The numbers are read on demand when you open this page. Postora does not store them.",
      separateFromGoogle: "This permission is separate from, and in addition to, the permissions you grant Postora at Google. It does not change those Google permissions.",
      howToStop: "You can stop analytics at any time using the control on this page. Stopping takes effect immediately.",
      versionAndLinks: "Analytics Purpose Clause, version 1, dated 2026-11-26. Read the Privacy Policy and Google API disclosure.",
      allowButton: "Allow analytics for this channel",
      notNowButton: "Not now",
      declinedNotice: "Analytics is off for this channel until you allow it.",
      permissionLine: "Analytics permission",
      withdrawTrigger: "Stop using analytics for this channel",
      withdrawConfirmBody: "The reports disappear now. Your channel stays connected, publishing and comments are unaffected, and your permissions at Google do not change. You can allow analytics again later.",
      withdrawConfirmAction: "Stop analytics",
      withdrawCancelAction: "Keep analytics",
      privacyLink: "Privacy Policy",
      disclosureLink: "Google API disclosure",
    },
    ar: {
      channelHeading: "السماح بتحليلات YouTube لقناة {{channel}}؟",
      whatWeRead: "ستقرأ Postora المشاهدات ووقت المشاهدة ومتوسط مدة المشاهدة والمشتركين المكتسبين والمفقودين والإعجابات والتعليقات والمشاركات لهذه القناة ولكل فيديو من YouTube Analytics.",
      whyWeRead: "تُستخدم هذه الأرقام فقط لعرضها لك، بصفتك مالك القناة، داخل Postora. لا تستخدمها Postora لأي غرض آخر.",
      whoSeesIt: "أنت فقط، مالك القناة الذي سجّل الدخول، يمكنك رؤية هذه الأرقام.",
      onDemandNoStorage: "تُقرأ الأرقام عند الطلب عندما تفتح هذه الصفحة. لا تخزّنها Postora.",
      separateFromGoogle: "هذا الإذن منفصل عن الأذونات التي تمنحها لـ Postora في Google ويضاف إليها، ولا يغيّر أذونات Google تلك.",
      howToStop: "يمكنك إيقاف التحليلات في أي وقت باستخدام عنصر التحكم في هذه الصفحة، ويسري الإيقاف فوراً.",
      versionAndLinks: "بند غرض التحليلات، الإصدار 1، بتاريخ 2026-11-26. اقرأ سياسة الخصوصية وإفصاح Google API.",
      allowButton: "السماح بالتحليلات لهذه القناة",
      notNowButton: "ليس الآن",
      declinedNotice: "التحليلات متوقفة لهذه القناة حتى تسمح بها.",
      permissionLine: "إذن التحليلات",
      withdrawTrigger: "إيقاف استخدام التحليلات لهذه القناة",
      withdrawConfirmBody: "ستختفي التقارير الآن. تبقى القناة متصلة، ولا يتأثر النشر أو التعليقات، ولا تتغير أذوناتك في Google. يمكنك السماح بالتحليلات مرة أخرى لاحقاً.",
      withdrawConfirmAction: "إيقاف التحليلات",
      withdrawCancelAction: "الاحتفاظ بالتحليلات",
      privacyLink: "سياسة الخصوصية",
      disclosureLink: "إفصاح Google API",
    },
  },
  2: {
    en: {
      channelHeading: "Allow YouTube Analytics for {{channel}}?",
      whatWeRead: "Postora will read views, watch time, average view duration, subscribers gained and lost, likes, comments, shares, viewer country, device type, traffic sources, and audience retention for this channel and each video from YouTube Analytics, and let you export loaded reports to your own device.",
      whyWeRead: "These numbers are used solely to display them to you, the channel owner, inside Postora and to let you export them to your own device. Postora uses them for no other purpose.",
      whoSeesIt: "Only you, the signed-in channel owner, can see or export these numbers.",
      onDemandNoStorage: "The numbers are read on demand when you open this page. Postora does not store them.",
      separateFromGoogle: "This permission is separate from, and in addition to, the permissions you grant Postora at Google. It does not change those Google permissions.",
      howToStop: "You can stop analytics at any time using the control on this page. Stopping takes effect immediately.",
      versionAndLinks: "Analytics Purpose Clause, version 2, dated 2026-11-26. Read the Privacy Policy and Google API disclosure.",
      allowButton: "Allow analytics for this channel",
      notNowButton: "Not now",
      declinedNotice: "Analytics is off for this channel until you allow it.",
      permissionLine: "Analytics permission",
      withdrawTrigger: "Stop using analytics for this channel",
      withdrawConfirmBody: "The reports disappear now. Your channel stays connected, publishing and comments are unaffected, and your permissions at Google do not change. You can allow analytics again later.",
      withdrawConfirmAction: "Stop analytics",
      withdrawCancelAction: "Keep analytics",
      privacyLink: "Privacy Policy",
      disclosureLink: "Google API disclosure",
    },
    ar: {
      channelHeading: "السماح بتحليلات YouTube لقناة {{channel}}؟",
      whatWeRead: "ستقرأ Postora المشاهدات ووقت المشاهدة ومتوسط مدة المشاهدة والمشتركين المكتسبين والمفقودين والإعجابات والتعليقات والمشاركات ودولة المشاهد ونوع الجهاز ومصادر الزيارات واحتفاظ الجمهور لهذه القناة ولكل فيديو من YouTube Analytics، وتتيح لك تصدير التقارير المحمّلة إلى جهازك الخاص.",
      whyWeRead: "تُستخدم هذه الأرقام فقط لعرضها لك، بصفتك مالك القناة، داخل Postora ولتمكينك من تصديرها إلى جهازك الخاص. لا تستخدمها Postora لأي غرض آخر.",
      whoSeesIt: "أنت فقط، مالك القناة الذي سجّل الدخول، يمكنك رؤية هذه الأرقام أو تصديرها.",
      onDemandNoStorage: "تُقرأ الأرقام عند الطلب عندما تفتح هذه الصفحة. لا تخزّنها Postora.",
      separateFromGoogle: "هذا الإذن منفصل عن الأذونات التي تمنحها لـ Postora في Google ويضاف إليها، ولا يغيّر أذونات Google تلك.",
      howToStop: "يمكنك إيقاف التحليلات في أي وقت باستخدام عنصر التحكم في هذه الصفحة، ويسري الإيقاف فوراً.",
      versionAndLinks: "بند غرض التحليلات، الإصدار 2، بتاريخ 2026-11-26. اقرأ سياسة الخصوصية وإفصاح Google API.",
      allowButton: "السماح بالتحليلات لهذه القناة",
      notNowButton: "ليس الآن",
      declinedNotice: "التحليلات متوقفة لهذه القناة حتى تسمح بها.",
      permissionLine: "إذن التحليلات",
      withdrawTrigger: "إيقاف استخدام التحليلات لهذه القناة",
      withdrawConfirmBody: "ستختفي التقارير الآن. تبقى القناة متصلة، ولا يتأثر النشر أو التعليقات، ولا تتغير أذوناتك في Google. يمكنك السماح بالتحليلات مرة أخرى لاحقاً.",
      withdrawConfirmAction: "إيقاف التحليلات",
      withdrawCancelAction: "الاحتفاظ بالتحليلات",
      privacyLink: "سياسة الخصوصية",
      disclosureLink: "إفصاح Google API",
    },
  },
} as const;

export type AnalyticsPurposeVersion = keyof typeof ANALYTICS_PURPOSE_TEXT;
export type AnalyticsPurposeLocale = keyof (typeof ANALYTICS_PURPOSE_TEXT)[AnalyticsPurposeVersion];
export type AnalyticsPurposeText = (typeof ANALYTICS_PURPOSE_TEXT)[AnalyticsPurposeVersion][AnalyticsPurposeLocale];

export function getAnalyticsPurposeText(locale: string, version: AnalyticsPurposeVersion = ANALYTICS_PURPOSE_VERSION as AnalyticsPurposeVersion): AnalyticsPurposeText {
  return ANALYTICS_PURPOSE_TEXT[version][locale.startsWith("ar") ? "ar" : "en"];
}
