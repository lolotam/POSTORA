import React from "react";
import { createRoot } from "react-dom/client";
import { initSentry } from "./lib/sentry";
import { installStaleChunkListener } from "./lib/staleChunk";
import App from "./App.tsx";
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
