import React from "react";
import { createRoot } from "react-dom/client";
import { initSentry } from "./lib/sentry";
import { installStaleChunkListener } from "./lib/staleChunk";
import App from "./App.tsx";
// Must precede the first render: useTranslation on an uninitialised i18next
// falls back to a stub translator instead of failing, so a late import looks
// like it works. Also sets document lang/dir, which is what the logical-property
// styling in the UI primitives keys off.
import "./i18n";
import "./index.css";

// Initialize Sentry as early as possible
initSentry();
// A dynamic import that 404s after a deploy becomes a "new version" prompt, not a crash.
installStaleChunkListener();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
