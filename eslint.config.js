import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: [
      "src/features/whatsapp-inbox/application/**/*.{ts,tsx}",
      "src/features/whatsapp-inbox/domain/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "**/infrastructure/**",
            "**/infrastructure/*",
            "@/features/whatsapp-inbox/infrastructure/**",
            "@/features/whatsapp-inbox/infrastructure/*",
          ],
          message: "whatsapp-inbox application/ and domain/ must depend on application/ports.ts, not infrastructure. The composition root injects the adapter.",
        }],
      }],
    },
  },
  {
    files: [
      "src/features/ai-providers/application/**/*.{ts,tsx}",
      "src/features/ai-providers/ui/**/*.{ts,tsx}",
    ],
    ignores: ["src/features/ai-providers/ui/AiProvidersPanel.tsx", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/infrastructure/**", "**/infrastructure/*", "@/integrations/supabase/client"],
          message: "AI providers depend on application/ports.ts. Only AiProvidersPanel composes infrastructure; only infrastructure imports Supabase.",
        }],
      }],
    },
  },
);
