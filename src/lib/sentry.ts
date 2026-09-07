import * as Sentry from "@sentry/react";

// Overridable per deployment; the literal is the Postora project DSN. A DSN is a public
// ingest address, not a secret, so a fallback in source is safe.
const SENTRY_DSN =
  import.meta.env.VITE_SENTRY_DSN ||
  "https://ec92b6803c7ea7187dbc282906cab7a4@o4508088707448832.ingest.us.sentry.io/4510744147656704";

export function initSentry() {
  const isProduction = import.meta.env.PROD;
  // A dev server reports every hot-reload ReferenceError as a production-looking issue
  // (eight of thirteen open issues on 2026-09-07 were localhost). Dev sends only when a
  // DSN is set explicitly for that purpose.
  if (!isProduction && !import.meta.env.VITE_SENTRY_DSN) {
    console.log("[Sentry] Disabled in development (set VITE_SENTRY_DSN to enable)");
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    
    // Enable logs for structured logging
    _experiments: {
      enableLogs: true,
    },
    
    integrations: [
      // Browser tracing for performance monitoring
      Sentry.browserTracingIntegration(),
      // Replay for session recording on errors. The defaults mask text and block media: the
      // inbox renders customers' WhatsApp messages, which must not reach Sentry in clear.
      Sentry.replayIntegration(),
    ],
    
    // Performance monitoring
    tracesSampleRate: isProduction ? 0.1 : 1.0, // 10% in prod, 100% in dev
    
    // Session replay: only sessions that hit an error are recorded.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    
    // Environment
    environment: isProduction ? "production" : "development",
    
    // Send default PII data
    sendDefaultPii: true,
    
    // Before send hook - can filter/modify events
    beforeSend(event, hint) {
      // Log locally in development
      if (!isProduction) {
        console.log("[Sentry] Event captured:", event.exception?.values?.[0]?.value);
      }
      return event;
    },
  });
  
  console.log(`[Sentry] Initialized in ${isProduction ? "production" : "development"} mode`);
}

// Re-export Sentry for use throughout the app
export { Sentry };

// Helper to capture exceptions with additional context
export function captureError(error: Error, context?: Record<string, unknown>) {
  Sentry.captureException(error, {
    extra: context,
  });
}

// Helper to set user context
export function setUserContext(userId: string | null, email?: string) {
  if (userId) {
    Sentry.setUser({ id: userId, email });
  } else {
    Sentry.setUser(null);
  }
}

// Helper for custom span instrumentation
export function startSpan<T>(
  options: { op: string; name: string },
  callback: () => T
): T {
  return Sentry.startSpan(options, callback);
}

// Helper for async span instrumentation
export async function startAsyncSpan<T>(
  options: { op: string; name: string },
  callback: () => Promise<T>
): Promise<T> {
  return Sentry.startSpan(options, callback);
}
