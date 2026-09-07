import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Dokploy writes the app's variables into a .env in the build context; Vite only lifts
  // VITE_* from it into import.meta.env, so a build-time secret has to be read explicitly.
  const buildEnv = loadEnv(mode, process.cwd(), "");
  const sentryAuthToken = buildEnv.SENTRY_AUTH_TOKEN;
  // Slugs, not ids: Sentry lets an org or project be renamed, and the upload then fails with
  // "Project not found" until this catches up (happened 2026-09-07). Overridable from the env.
  const sentryOrg = buildEnv.SENTRY_ORG || "lolotam";
  const sentryProject = buildEnv.SENTRY_PROJECT || "postora";

  return {
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    // Uploads the production source maps to Sentry so stack traces are readable, then
    // deletes them from dist so they are not served from postora.cloud. Without a token
    // the plugin is disabled and the Dockerfile still strips the maps.
    mode === "production" && sentryVitePlugin({
      org: sentryOrg,
      project: sentryProject,
      authToken: sentryAuthToken,
      disable: !sentryAuthToken,
      telemetry: false,
      sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Function form, not the object form. Rolldown (used by Vite 7+) dropped
        // support for the record shorthand and throws "manualChunks is not a
        // function", while Rollup (Vite 5/6) accepts both — so this spelling builds
        // on either bundler and survives the next Vite bump.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;

          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)) {
            return "vendor-react";
          }
          if (id.includes("@radix-ui")) return "vendor-ui";
          if (id.includes("recharts")) return "vendor-charts";
          if (id.includes("@tanstack/react-query")) return "vendor-query";
          if (id.includes("framer-motion")) return "vendor-motion";
          if (id.includes("date-fns")) return "vendor-dates";
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    // The Supabase client throws at import time when these are unset, which took
    // three test files down in CI while passing locally purely because a developer
    // has a gitignored .env. Tests mock Supabase and must never reach a real
    // backend, so hermetic placeholders are correct here — and they keep the suite
    // independent of any local .env. Applies to the test run only.
    env: {
      VITE_SUPABASE_URL: "http://127.0.0.1:54321",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    },
  },
  };
});
