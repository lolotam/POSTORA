/**
 * i18next bootstrap.
 *
 * Imported for its side effect by `src/main.tsx` before the first render, because
 * `useTranslation` on an uninitialised instance silently falls back to a stub
 * translator: the copy still renders, so the failure is invisible until someone
 * adds a second language and nothing translates.
 *
 * English is NOT shipped as a resource bundle. Every call site already passes its
 * English copy as the `t(key, "English copy")` default, so a parallel `en` bundle
 * would be a second source of truth for the same string and the two would drift.
 * The namespace is declared empty instead, which lets every lookup fall through to
 * that default without an "unloaded namespace" warning. Translated languages (currently
 * Egyptian colloquial Arabic, `ar`) ship as real bundles statically imported and keyed
 * the same way.
 */
import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import common from "./locales/ar/common.json";
import nav from "./locales/ar/nav.json";
import apikeys from "./locales/ar/apikeys.json";
import dashboard from "./locales/ar/dashboard.json";
import calendar from "./locales/ar/calendar.json";
import history from "./locales/ar/history.json";
import post from "./locales/ar/post.json";
import postsettings from "./locales/ar/postsettings.json";
import postmedia from "./locales/ar/postmedia.json";
import postpreview from "./locales/ar/postpreview.json";
import accounts from "./locales/ar/accounts.json";

/** Languages with copy behind them. Anything detected outside this list resolves to `en`. */
export const SUPPORTED_LANGUAGES = ["en", "ar"] as const;

const DEFAULT_LANGUAGE = "en";

void i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    // Without this a browser reporting "en-US" matches nothing in supportedLngs
    // and the language never resolves, which leaves i18next.dir() guessing from
    // an empty code. Region subtags fold onto their base language instead.
    nonExplicitSupportedLngs: true,
    ns: ["common", "nav", "apikeys", "dashboard", "calendar", "history", "post", "postsettings", "postmedia", "postpreview", "accounts"],
    defaultNS: "common",
    resources: {
      en: {
        common: {},
        nav: {},
        apikeys: {},
        dashboard: {},
        calendar: {},
        history: {},
        post: {},
        postsettings: {},
        postmedia: {},
        postpreview: {},
        accounts: {},
      },
      ar: {
        common,
        nav,
        apikeys,
        dashboard,
        calendar,
        history,
        post,
        postsettings,
        postmedia,
        postpreview,
        accounts,
      },
    },
    // React escapes interpolated values already; escaping here would double-encode.
    interpolation: { escapeValue: false },
    detection: {
      order: ["querystring", "localStorage", "navigator", "htmlTag"],
      lookupQuerystring: "lang",
      lookupLocalStorage: "postora.language",
      caches: ["localStorage"],
    },
  });

/**
 * Mirrors the active language onto the document. `dir` is what activates the
 * logical-property styling in the UI primitives, so without this the RTL work
 * across those components can never take effect.
 *
 * Reads `i18next.language`, never `resolvedLanguage`: the latter is `undefined`
 * here even after a successful init, so defaulting off it would pin every
 * visitor to ltr and silently defeat the RTL styling for a right-to-left
 * language. `dir()` with no argument asks i18next about the language actually
 * in force rather than one we guessed.
 */
function applyDocumentLanguage(): void {
  const root = document.documentElement;
  root.lang = i18next.language || DEFAULT_LANGUAGE;
  root.dir = i18next.dir();
}

applyDocumentLanguage();
i18next.on("languageChanged", applyDocumentLanguage);

export default i18next;
