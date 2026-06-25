## Plan: Debug and fix AI image generation

### Diagnosis from code inspection
The current failure is very likely inside `supabase/functions/generate-image/index.ts`, not the toast UI.

Key problems found:
- The function calls `https://ai.gateway.lovable.dev/v1/chat/completions` for image generation, but the supported image-generation path should use `/v1/images/generations` for OpenAI image models and a model-specific request body for Gemini image models.
- The UI has hardcoded image models that do not match the current supported catalog exactly:
  - `google/gemini-3-pro-image-preview` should be replaced with supported IDs like `google/gemini-3-pro-image` or `google/gemini-3.1-flash-image`.
- `generate-image` ignores the admin default image model from `/admin/settings`; it only uses the model sent by the UI and then falls back to a hardcoded Gemini model.
- The previous manual SQL added newer image model rows, but the runtime function still maps only old/hardcoded IDs.
- The current error mapping hides the real provider error behind a generic “AI service temporarily unavailable” message.

### Implementation steps
1. **Fix supported image model catalog in the frontend**
   - Update `src/components/post/ImageGenerator.tsx` image model choices to use supported model IDs.
   - Remove or replace unsupported/legacy image model IDs that can cause guaranteed provider failure.

2. **Fix the `generate-image` Edge Function request path**
   - Update `supabase/functions/generate-image/index.ts` so image generation uses the proper Gateway image endpoint and body shape.
   - For `openai/gpt-image-2` / `openai/gpt-image-1-mini`: send `{ model, prompt, quality, size, n, stream: false }` or non-streaming JSON for this current UI.
   - For `google/gemini-*image*`: send `{ model, messages, modalities: ['image','text'], stream: false }`.
   - Parse the normalized response from `data[0].b64_json` and return `data:image/png;base64,...` to the existing UI.

3. **Use admin default image model safely**
   - If the client does not send a valid supported image model, resolve `default_ai_model_image` via `get_active_ai_model_config(user.id, 'image')`.
   - If the admin default is unsupported/legacy, fall back to a known working supported model.

4. **Improve diagnostics without leaking secrets**
   - Log sanitized provider status/error code to `system_logs`.
   - Return structured `success:false` error codes with a more useful message, without printing API keys or raw secret values.
   - Preserve existing CORS behavior.

5. **Manual SQL script only if needed**
   - Create a manual SQL file to update stale default image model settings to supported IDs if the database currently points to retired/unsupported values.
   - The SQL will not be executed automatically.

6. **Validation**
   - Run available validation scripts from `package.json` only.
   - Run `git diff --check`.
   - Review changed production code with CleanCodeGuard.
   - TestGuard: no test-code review unless test files are changed.

### External/manual actions required after implementation
Because this project is self-hosted, code changes to Edge Functions will not take effect until you deploy/restart the function on the Contabo self-hosted stack. I will include the exact deploy command in the final report.