import { encode as base64Encode, decode as base64Decode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { HiggsfieldAuthError, resolveHiggsfieldCredential } from "../_shared/higgsfield-oauth.ts";
import { HiggsfieldMcpClient, McpError, findJobId, findOutputUrl } from "../_shared/higgsfield-mcp.ts";
import { checkByoGenerationLimits } from "../_shared/higgsfield-rate-limit.ts";
import { mergeModelSpec, sanitizeParams, missingRequiredParams, resolveAspectRatio, defaultParamsFor } from "../_shared/higgsfield-model-spec.ts";
import type { ReferenceInput } from "../_shared/image-references.ts";
import { vercelGenerateImage } from "../_shared/vercelGateway.ts";
import { pickRequestedModelRow } from "./modelChoice.ts";
import { isPublicHttpsUrl, parseDataUrl } from "../_shared/image-references.ts";
import { budgetSignal, timeLeftMs, NotEnoughTimeError, type CallBudget } from "./callBudget.ts";

export const PROVIDER_MIN_MS: Record<string, number> = { higgsfield: 45_000, openai: 45_000, google: 20_000, vercel: 20_000 };
export class ProviderOutcomeUnknownError extends Error {}
export interface ImageJobInput { userId: string; prompt: string; requestedModel?: string; aspectRatio?: string; quality?: string;
  references: ReferenceInput[]; budget: CallBudget }
export type ImageRunResult =
  | { kind: "succeeded"; imageUrl: string; description: string; usedModel: ResolvedModel; credentialSource: "platform" | "byo"; attemptErrors: string[] }
  | { kind: "refused"; status: 402 | 429; message: string; errorCode: "ai_quota_exhausted" | "ai_rate_limited" }
  | { kind: "outcome_unknown"; message: string; usedModel: ResolvedModel; credentialSource: "platform" | "byo" }
  | { kind: "lease_lost" }
  | { kind: "failed"; message: string; attemptErrors: string[] };
export interface ImageRunDeps {
  onDispatch(): Promise<boolean>;
  resolveChain(requestedModel?: string): Promise<ResolvedModel[]>;
  getApiKey(m: ResolvedModel): Promise<string | null>;
  generateWithModel(m: ResolvedModel, apiKey: string, prompt: string, aspectRatio: string, references: ReferenceInput[], budget: CallBudget): Promise<{ imageUrl: string; description: string }>;
  resolveHiggsfieldCredential(userId: string): Promise<{ source: "platform" | "byo" }>;
  checkByoLimits(userId: string): Promise<{ allowed: boolean; error?: string }>;
  reserveQuota(userId: string): Promise<boolean>;
  releaseQuota(userId: string): Promise<void>;
  /** Throws ProviderOutcomeUnknownError when generate_image was sent and the outcome is not a definitive rejection. */
  generateWithHiggsfield(input: { m: ResolvedModel; cred: unknown; prompt: string; rawPrompt: string; aspectRatio?: string;
    references: ReferenceInput[]; userId: string; budget: CallBudget }): Promise<{ url: string; params: Record<string, unknown> }>;
  recordHiggsfieldSuccess(row: { userId: string; m: ResolvedModel; credentialSource: string; url: string; rawPrompt: string;
    params: Record<string, unknown>; reserved: boolean }): Promise<void>;
}

// =====================================================================
// Image model resolution — reads from admin dashboard settings:
//   system_settings.default_ai_model_image           (primary)
//   system_settings.default_ai_model_image_fallback  (fallback)
//   + final hardcoded fallback: Imagen via GOOGLE_AI_STUDIO_KEY.
// No Lovable AI Gateway dependency. Each provider is called directly
// with its own api_key (env var first, provider_api_keys table second).
// =====================================================================

export interface ResolvedModel {
  provider_code: string;
  model_id: string;
  api_endpoint: string;
  api_key_env_var: string;
  api_type: string; // 'openai' | 'google' | ...
  source: 'requested' | 'primary' | 'fallback' | 'fallback_2' | 'hardcoded';
  /** Administrator-set knobs for this model, from ai_models.admin_params. */
  admin_params: Record<string, string | number | boolean>;
}

// Last resort when no configured model can run. Must be a model the key can
// actually call: imagen-4.0-generate-001 was 404ing because Imagen is not
// offered on this account and does not support generateContent anyway, which
// left the chain with no working floor. gemini-2.5-flash-image is available and
// was this app's own previous default.
const HARDCODED_FALLBACK: ResolvedModel = {
  provider_code: 'gemini',
  model_id: 'gemini-2.5-flash-image',
  api_endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  api_key_env_var: 'GOOGLE_AI_STUDIO_KEY',
  api_type: 'google',
  source: 'hardcoded',
  admin_params: {},
};

async function lookupModelByProviderAndId(
  supabaseAdmin: any,
  provider_code: string,
  model_id: string,
  source: ResolvedModel['source'],
): Promise<ResolvedModel | null> {
  const { data } = await supabaseAdmin
    .from('ai_models')
    .select('model_id, admin_params, ai_providers!inner(provider_code, api_endpoint, api_key_env_var, api_type, is_active)')
    .eq('model_id', model_id)
    .eq('ai_providers.provider_code', provider_code)
    .eq('is_active', true)
    .maybeSingle();
  if (!data?.ai_providers || !data.ai_providers.is_active) return null;
  return {
    provider_code: data.ai_providers.provider_code,
    model_id: data.model_id,
    api_endpoint: data.ai_providers.api_endpoint,
    api_key_env_var: data.ai_providers.api_key_env_var,
    api_type: data.ai_providers.api_type,
    source,
    admin_params: (data.admin_params ?? {}) as Record<string, string | number | boolean>,
  };
}

async function getSystemSettingModel(
  supabaseAdmin: any,
  key: string,
  source: ResolvedModel['source'],
): Promise<ResolvedModel | null> {
  const { data } = await supabaseAdmin.from('system_settings').select('value').eq('key', key).maybeSingle();
  const v = data?.value;
  if (!v?.provider_code || !v?.model_id) return null;
  return lookupModelByProviderAndId(supabaseAdmin, v.provider_code, v.model_id, source);
}

async function resolveModelChain(supabaseAdmin: any, requestedModelId?: string): Promise<ResolvedModel[]> {
  const chain: ResolvedModel[] = [];
  const seen = new Set<string>();
  const push = (m: ResolvedModel | null) => {
    if (!m) return;
    const k = `${m.provider_code}::${m.model_id}`;
    if (seen.has(k)) return;
    seen.add(k);
    chain.push(m);
  };

  // 1. Requested model (frontend dropdown picked something explicit).
  // Vercel and OpenRouter can hold the same vendor-prefixed model_id (e.g.
  // 'openai/gpt-image-2'), so this looks up every matching row and picks one
  // deterministically instead of a `.maybeSingle()` that errors on >1 row.
  if (requestedModelId) {
    const { data: rows } = await supabaseAdmin
      .from('ai_models')
      .select('model_id, admin_params, ai_providers!inner(provider_code, api_endpoint, api_key_env_var, api_type, is_active)')
      .eq('model_id', requestedModelId)
      .eq('is_active', true)
      .contains('capabilities', ['image']);
    const { data: def } = await supabaseAdmin.from('system_settings').select('value').eq('key', 'default_ai_model_image').maybeSingle();
    type ImageModelRow = {
      model_id: string;
      admin_params: Record<string, string | number | boolean> | null;
      ai_providers: { provider_code: string; api_endpoint: string; api_key_env_var: string; api_type: string; is_active: boolean } | null;
    };
    const preferred = pickRequestedModelRow((rows ?? []) as ImageModelRow[], def?.value?.provider_code);
    const provider = preferred?.ai_providers;
    if (preferred && provider) {
      push({
        provider_code: provider.provider_code,
        model_id: preferred.model_id,
        api_endpoint: provider.api_endpoint,
        api_key_env_var: provider.api_key_env_var,
        api_type: provider.api_type,
        source: 'requested',
        admin_params: preferred.admin_params ?? {},
      });
    }
  }

  // 2. Admin primary
  push(await getSystemSettingModel(supabaseAdmin, 'default_ai_model_image', 'primary'));
  // 3. Admin fallback
  push(await getSystemSettingModel(supabaseAdmin, 'default_ai_model_image_fallback', 'fallback'));
  // 4. Admin second fallback
  push(await getSystemSettingModel(supabaseAdmin, 'default_ai_model_image_fallback_2', 'fallback_2'));
  // 5. Hardcoded last-resort
  push(HARDCODED_FALLBACK);

  return chain;
}

async function getProviderApiKey(supabaseAdmin: any, m: ResolvedModel): Promise<string | null> {
  const fromEnv = Deno.env.get(m.api_key_env_var);
  if (fromEnv) return fromEnv;
  const { data } = await supabaseAdmin
    .from('provider_api_keys')
    .select('api_key')
    .eq('provider_code', m.provider_code)
    .maybeSingle();
  return data?.api_key || null;
}


// ── Reference images ──────────────────────────────────────────────────
// The dialogs let the user attach a reference; these turn that attachment into
// whatever the chosen provider actually accepts.

/** Largest reference we will decode or forward, before base64 expansion. */
const MAX_REFERENCE_BYTES = 3_000_000;
/** How long Higgsfield has to fetch a staged reference before the link dies. */
const REFERENCE_URL_TTL_SECONDS = 3600;
/** Redirect hops allowed while fetching a reference. */
const MAX_REFERENCE_REDIRECTS = 3;
/** Ceiling on a single reference fetch, so a slow host cannot hold the isolate. */
const REFERENCE_FETCH_TIMEOUT_MS = 20_000;

/**
 * Fetch a reference URL, checking every hop.
 *
 * `fetch` follows redirects itself, so validating only the URL the caller gave
 * us would let a public address redirect into the internal network. Redirects
 * are followed by hand instead, with each destination checked before it is
 * requested.
 */
async function fetchReference(url: string, budget: CallBudget): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_REFERENCE_REDIRECTS; hop++) {
    if (!isPublicHttpsUrl(target)) {
      throw new Error('reference image must be an https URL on a public host');
    }
    const resp = await fetch(target, {
      redirect: 'manual',
      signal: budgetSignal(budget, 2_000, REFERENCE_FETCH_TIMEOUT_MS),
    });
    if (resp.status < 300 || resp.status > 399) return resp;

    const location = resp.headers.get('location');
    await resp.body?.cancel();
    if (!location) throw new Error('reference image redirect had no location');
    target = new URL(location, target).toString();
  }
  throw new Error('reference image redirected too many times');
}

/**
 * Read a body, giving up once it exceeds the cap.
 *
 * Buffering first and measuring afterwards lets a host that omits
 * content-length exhaust the isolate before the size is ever checked.
 */
async function readBoundedBody(resp: Response): Promise<Uint8Array> {
  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REFERENCE_BYTES) {
    throw new Error('reference image is too large');
  }
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('reference image had no body');

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REFERENCE_BYTES) {
      await reader.cancel();
      throw new Error('reference image is too large');
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Read a reference image as base64, whichever form it arrived in.
 *
 * Gemini takes reference bytes inline, so an https URL has to be fetched first.
 */
async function readReferenceBytes(url: string, budget: CallBudget): Promise<{ mimeType: string; base64: string }> {
  const inline = parseDataUrl(url);
  if (inline) return inline;

  const resp = await fetchReference(url, budget);
  if (!resp.ok) throw new Error(`could not read reference image (${resp.status})`);
  const mimeType = resp.headers.get('content-type')?.split(';')[0] || 'image/png';
  const bytes = await readBoundedBody(resp);
  return { mimeType, base64: base64Encode(new Uint8Array(bytes).buffer) };
}

/**
 * The publicly reachable origin of this Supabase instance.
 *
 * SUPABASE_URL is the in-cluster Kong address (http://kong:8000), so anything
 * built from it is unreachable from outside — and Higgsfield rejects it
 * outright, since it only imports over https.
 */
function publicSupabaseOrigin(): string {
  const base = Deno.env.get('SUPABASE_PUBLIC_URL')
    || Deno.env.get('API_EXTERNAL_URL')
    || Deno.env.get('SUPABASE_URL')
    || '';
  return base.replace(/\/$/, '');
}

/**
 * Give Higgsfield a URL it can fetch.
 *
 * It imports references by URL, so an upload that arrived as a data: URL has to
 * be hosted first. The media bucket is private, so the reference gets a
 * short-lived signed URL rather than the bucket being opened up.
 */
async function stageReferenceUrl(
  supabaseAdmin: any,
  userId: string,
  url: string,
  budget: CallBudget,
): Promise<{ url: string; stagedPath: string | null }> {
  if (!url.startsWith('data:')) return { url, stagedPath: null };
  const inline = parseDataUrl(url);
  if (!inline) throw new Error('unsupported reference image format');

  const { mimeType: contentType, base64: encoded } = inline;
  const bytes = base64Decode(encoded);
  if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error('reference image is too large');

  const extension = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const path = `${userId}/ai-references/${crypto.randomUUID()}.${extension}`;
  budgetSignal(budget, 2_000);
  const { error } = await supabaseAdmin.storage.from('media').upload(path, bytes, { contentType });
  if (error) throw new Error(`could not stage the reference image: ${error.message}`);

  budgetSignal(budget, 2_000);
  const { data, error: signError } = await supabaseAdmin.storage
    .from('media')
    .createSignedUrl(path, REFERENCE_URL_TTL_SECONDS);
  if (signError || !data?.signedUrl) {
    throw new Error(`could not sign the reference image: ${signError?.message || 'no URL returned'}`);
  }
  // The client builds signed URLs on SUPABASE_URL, so the path is re-hosted on
  // the public origin before it is handed to a service outside this network.
  const signed = new URL(data.signedUrl);
  return { url: `${publicSupabaseOrigin()}${signed.pathname}${signed.search}`, stagedPath: path };
}

/**
 * Upload the references to Higgsfield and return the `medias` entries that bind
 * them to the generation, or null when this model runs from text alone.
 *
 * Throwing here skips the candidate rather than failing the request, so a model
 * that cannot take the attachment hands over to the next tier instead of
 * generating from the prompt as though no reference had been given.
 */
interface ReferenceImportRequest {
  mcp: HiggsfieldMcpClient;
  supabaseAdmin: any;
  userId: string;
  spec: { maxReferenceImages: number; referenceRoles: string[]; requiresReferenceImage: boolean };
  references: ReferenceInput[];
  modelId: string;
  /**
   * Collects the storage paths staged for this attempt so the caller can remove
   * them. It is filled as work proceeds rather than returned, so the paths
   * survive a throw partway through and are still cleaned up.
   */
  stagedPaths: string[];
  budget: CallBudget;
}

async function importReferences(req: ReferenceImportRequest): Promise<{ role: string; value: string }[] | null> {
  const { mcp, supabaseAdmin, userId, spec, references, modelId, stagedPaths, budget } = req;
  if (references.length === 0) {
    if (spec.requiresReferenceImage) throw new Error(`${modelId} requires a reference image`);
    return null;
  }
  if (spec.maxReferenceImages === 0) throw new Error(`${modelId} does not accept a reference image`);

  const role = spec.referenceRoles[0] ?? 'image';
  const medias: { role: string; value: string }[] = [];
  for (const ref of references.slice(0, spec.maxReferenceImages)) {
    const { url, stagedPath } = await stageReferenceUrl(supabaseAdmin, userId, ref.url, budget);
    if (stagedPath) stagedPaths.push(stagedPath);
    let imported: unknown;
    try {
      imported = await mcp.callTool('media_import_url', { url, type: 'image' });
    } catch (err) {
      // McpError carries Higgsfield's own complaint in `data`. Without it the
      // attempt log says only that the tool "reported an error", which is not
      // enough to tell a rejected URL from an expired token.
      const detail = err instanceof McpError && err.data
        ? ` — ${JSON.stringify(err.data).slice(0, 300)}`
        : '';
      throw new Error(`${err instanceof Error ? err.message : String(err)}${detail}`);
    }
    const media = imported as Record<string, unknown> | null;
    const mediaId = media?.media_id ?? media?.mediaId ?? media?.id ?? findJobId(imported);
    if (!mediaId) throw new Error('Higgsfield could not import the reference image');
    medias.push({ role, value: String(mediaId) });
  }
  return medias;
}

// ── Provider dispatchers ──────────────────────────────────────────────
// Each returns { imageUrl, description } or throws.

const OPENAI_SIZE_MAP: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:5': '1024x1280',
  '4:3': '1280x1024',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
};

async function callOpenAIImages(m: ResolvedModel, apiKey: string, prompt: string, aspectRatio: string, budget: CallBudget) {
  const size = OPENAI_SIZE_MAP[aspectRatio] || '1024x1024';

    const resp = await fetch(`${m.api_endpoint.replace(/\/$/, '')}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m.model_id, prompt, size, n: 1, quality: 'low' }),
      signal: budgetSignal(budget, PROVIDER_MIN_MS.openai, 230_000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error(`OpenAI returned no image: ${JSON.stringify(data).slice(0, 200)}`);
    return { imageUrl: `data:image/png;base64,${b64}`, description: 'Image generated successfully' };

}

async function callGoogleGenerateContent(
  m: ResolvedModel,
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  references: ReferenceInput[],
  budget: CallBudget,
) {
  const promptParts: Record<string, unknown>[] = [{ text: prompt }];
  // The prompt already tells the model references are provided, so the bytes
  // have to follow it or the model is being asked to work from a description
  // of images it was never shown.
  for (const ref of references) {
    const { mimeType, base64 } = await readReferenceBytes(ref.url, budget);
    promptParts.push({ inline_data: { mime_type: mimeType, data: base64 } });
  }
  const body: any = {
    contents: [{ parts: promptParts }],
  };
  // Image-capable Gemini models accept imageConfig under generationConfig
  if (m.model_id.includes('image') && aspectRatio && aspectRatio !== 'free') {
    body.generationConfig = {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio },
    };
  }
  const resp = await fetch(`${m.api_endpoint.replace(/\/$/, '')}/models/${m.model_id}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: budgetSignal(budget, PROVIDER_MIN_MS.google),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p: any) => p.inline_data?.mime_type?.startsWith('image/') || p.inlineData?.mimeType?.startsWith('image/'));
  if (!imagePart) {
    throw new Error(`Google returned no image: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const inline = imagePart.inline_data || imagePart.inlineData;
  const mime = inline.mime_type || inline.mimeType;
  const b64 = inline.data;
  const textPart = parts.find((p: any) => p.text);
  return { imageUrl: `data:${mime};base64,${b64}`, description: textPart?.text || 'Image generated successfully' };
}

export async function generateWithModel(
  m: ResolvedModel,
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  references: ReferenceInput[],
  budget: CallBudget,
): Promise<{ imageUrl: string; description: string }> {
  if (m.provider_code === 'vercel') {
    if (references.length > 0) throw new Error('cannot take a reference image');
    budgetSignal(budget, PROVIDER_MIN_MS.vercel);
    return vercelGenerateImage(apiKey, m.model_id, prompt, aspectRatio, Math.min(50_000, Math.max(0, timeLeftMs(budget))));
  }
  if (m.api_type === 'openai' || m.provider_code === 'openai') {
    // /images/generations has no reference input at all — /images/edits is a
    // separate endpoint with a different contract. Refusing lets the chain fall
    // through to a model that can honour the attachment.
    if (references.length > 0) throw new Error('cannot take a reference image');
    return callOpenAIImages(m, apiKey, prompt, aspectRatio, budget);
  }
  if (m.api_type === 'google' || m.provider_code === 'gemini') {
    return callGoogleGenerateContent(m, apiKey, prompt, aspectRatio, references, budget);
  }
  throw new Error(`Unsupported provider api_type='${m.api_type}' (provider=${m.provider_code})`);
}

export function buildImagePrompt(prompt: string, references: ReferenceInput[], aspectRatio?: string, quality?: string): string {
// Build prompt with reference image context if available
let referenceContext = '';
if (references.length > 0) {
  const refDescriptions = references.map((ref) => {
    switch (ref.type) {
      case 'style':
        return `Style reference (priority ${ref.priority}): Use the artistic style, colors, and mood from this image`;
      case 'content':
        return `Content reference (priority ${ref.priority}): Use the subject matter and composition from this image`;
      case 'image-to-image':
        return `Image-to-image (priority ${ref.priority}): Transform this image according to the prompt while preserving its core structure`;
      default:
        return `Reference (priority ${ref.priority}): Use this as inspiration`;
    }
  });
  referenceContext = `

Reference images are provided in order of influence (first = most important):
${refDescriptions.join('\n')}

Apply the references according to their types - style references affect visual aesthetics, content references guide subject matter, and image-to-image references should be transformed.`;
}

const fullPrompt = `Generate a high-quality image based on this description: ${prompt}.${referenceContext}

Style requirements:
- Professional, polished look suitable for social media
- High resolution and clear details
- Aspect ratio: ${aspectRatio}
${quality ? `- Quality level: ${quality}` : ''}

Make the image visually striking and engaging.`;

  return fullPrompt;
}

export function isDefinitiveHiggsfieldRejection(err: unknown): boolean {
  return err instanceof HiggsfieldAuthError || (err instanceof McpError && err.outcome === "rejected") || err instanceof NotEnoughTimeError;
}

export async function runImageGeneration(deps: ImageRunDeps, job: ImageJobInput): Promise<ImageRunResult> {
  const fullPrompt = buildImagePrompt(job.prompt, job.references, job.aspectRatio, job.quality);
  const chain = await deps.resolveChain(job.requestedModel);
  console.log("[generate-image] resolved model chain:", chain.map((c) => `${c.source}:${c.provider_code}/${c.model_id}`).join(" → "));
  const attemptErrors: string[] = [];
  let dispatched = false;
  const dispatchOnce = async () => (dispatched ||= await deps.onDispatch());
  const record = (m: ResolvedModel, err: unknown) => {
    const msg = `[${m.source}] ${m.provider_code}/${m.model_id}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    attemptErrors.push(msg);
  };

  for (const m of chain) {
    const isHiggsfield = m.provider_code === "higgsfield" || m.api_type === "higgsfield";
    const minMs = PROVIDER_MIN_MS[isHiggsfield ? "higgsfield" : m.provider_code] ?? 20_000;
    if (timeLeftMs(job.budget) < minMs) {
      attemptErrors.push(`[deadline] not enough time left for ${m.provider_code}/${m.model_id}`);
      continue;
    }
    if (isHiggsfield) {
      let cred: { source: "platform" | "byo" };
      try {
        cred = await deps.resolveHiggsfieldCredential(job.userId);
      } catch (err) {
        record(m, err);
        continue;
      }
      if (cred.source === "byo") {
        const byo = await deps.checkByoLimits(job.userId);
        if (!byo.allowed) return { kind: "refused", status: 429, message: byo.error ?? "Rate limit exceeded", errorCode: "ai_rate_limited" };
      }
      if (!(await dispatchOnce())) return { kind: "lease_lost" };
      let reserved = false;
      if (cred.source === "platform") {
        if (!(await deps.reserveQuota(job.userId))) {
          return { kind: "refused", status: 402, message: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" };
        }
        reserved = true;
      }
      let out: { url: string; params: Record<string, unknown> };
      try {
        out = await deps.generateWithHiggsfield({ m, cred, prompt: fullPrompt, rawPrompt: job.prompt, aspectRatio: job.aspectRatio,
          references: job.references, userId: job.userId, budget: job.budget });
      } catch (err) {
        if (err instanceof ProviderOutcomeUnknownError) {
          // Possibly billed upstream: no refund and no fallback (a second image could follow).
          console.error(`[generate-image] ${m.model_id}: outcome unknown, not refunded:`, err.message);
          return { kind: "outcome_unknown", message: err.message, usedModel: m, credentialSource: cred.source };
        }
        if (reserved) await deps.releaseQuota(job.userId);
        record(m, err);
        continue;
      }
      try {
        await deps.recordHiggsfieldSuccess({ userId: job.userId, m, credentialSource: cred.source, url: out.url,
          rawPrompt: job.prompt, params: out.params, reserved });
      } catch (err) {
        console.error("[generate-image] could not record the Higgsfield job row:", err instanceof Error ? err.message : err);
      }
      return { kind: "succeeded", imageUrl: out.url, description: `Generated with Higgsfield ${m.model_id}`, usedModel: m,
        credentialSource: cred.source, attemptErrors };
    }
    const apiKey = await deps.getApiKey(m);
    if (!apiKey) {
      const msg = `[${m.source}] ${m.provider_code}/${m.model_id}: missing ${m.api_key_env_var}`;
      console.warn(msg);
      attemptErrors.push(msg);
      continue;
    }
    if (!(await dispatchOnce())) return { kind: "lease_lost" };
    try {
      console.log(`[generate-image] attempt ${m.source} ${m.provider_code}/${m.model_id}`);
      // Platform-key providers reserve no user quota and a timed-out reply is discarded, so falling
      // back costs only the platform; the user never sees two images.
      const result = await deps.generateWithModel(m, apiKey, fullPrompt, job.aspectRatio ?? "", job.references, job.budget);
      return { kind: "succeeded", imageUrl: result.imageUrl, description: result.description, usedModel: m, credentialSource: "platform", attemptErrors };
    } catch (err) {
      record(m, err);
    }
  }
  return { kind: "failed", message: `All image providers failed. Attempts: ${attemptErrors.join(" | ")}`, attemptErrors };
}

// The Supabase SDK client is untyped at this adapter seam, as in the moved handler.
// deno-lint-ignore no-explicit-any
export function defaultImageRunDeps(admin: any, overrides: Pick<ImageRunDeps, "onDispatch" | "recordHiggsfieldSuccess">): ImageRunDeps {
  return {
    ...overrides,
    resolveChain: (requested) => resolveModelChain(admin, requested),
    getApiKey: (model) => getProviderApiKey(admin, model),
    generateWithModel,
    resolveHiggsfieldCredential: (userId) => resolveHiggsfieldCredential(admin, userId),
    checkByoLimits: (userId) => checkByoGenerationLimits(admin, userId),
    async reserveQuota(userId) {
      const { data, error } = await admin.rpc('reserve_ai_generation_quota', { p_user_id: userId });
      if (error) throw error;
      const quota = Array.isArray(data) ? data[0] : data;
      return quota?.allowed === true;
    },
    async releaseQuota(userId) {
      const { error } = await admin.rpc('release_ai_generation_quota', { p_user_id: userId });
      if (error) throw error;
    },
    async generateWithHiggsfield({ m, cred, prompt, aspectRatio, references, userId, budget }) {
      // Removed once the attempt is over: cleanup-media only walks media_files
      // rows, and these staging objects are deliberately not recorded there,
      // so nothing else would ever collect them.
      const stagedPaths: string[] = [];
      try {
        const { data: catalog } = await admin.from('ai_models').select('metadata').eq('model_id', m.model_id).maybeSingle();
        const spec = mergeModelSpec(m.model_id, catalog?.metadata, 'image');
        // Spec defaults are the floor, the administrator overrides them, and the
        // user's aspect ratio is applied last. sanitizeParams then drops anything
        // this model does not declare, so falling through to a model with
        // different knobs cannot send it a parameter it will reject.
        const params = sanitizeParams(spec, {
          ...defaultParamsFor(spec),
          ...m.admin_params,
          ...(aspectRatio ? { aspect_ratio: resolveAspectRatio(spec, aspectRatio) || aspectRatio } : {}),
        });
        const missing = missingRequiredParams(spec, params);
        if (missing.length) {
          // Skip this candidate, do not abort the chain. A model the
          // administrator has not finished configuring must not take the whole
          // run down with it — the next tier may well be ready.
          throw new Error(`needs ${missing.join(', ')} — set it in Admin › AI Configuration`);
        }
        const mcp = HiggsfieldMcpClient.fromCredential(cred as Parameters<typeof HiggsfieldMcpClient.fromCredential>[0], admin).withDeadline(budget.deadlineMs);
        // sanitizeParams keeps only what the spec declares, so the reference is
        // attached after it rather than passed through it.
        const medias = await importReferences({
          mcp, supabaseAdmin: admin, userId, spec, references, modelId: m.model_id, stagedPaths, budget,
        });
        let payload: unknown;
        try {
          payload = await mcp.callTool("generate_image", { params: { model: m.model_id, prompt, ...params, ...(medias ? { medias } : {}) } });
        } catch (err) {
          if (isDefinitiveHiggsfieldRejection(err)) throw err;
          throw new ProviderOutcomeUnknownError(`Higgsfield did not confirm the generation: ${err instanceof Error ? err.message : String(err)}`);
        }
        const generatedUrl = findOutputUrl(payload);
        // Accepted but no URL: a job may still be running (and billing) upstream.
        if (!generatedUrl) throw new ProviderOutcomeUnknownError("Higgsfield accepted the request but returned no image URL");
        return { url: generatedUrl, params };
      } finally {
        // Higgsfield has taken its own copy by now, so the staging object has
        // no further use. Failing to remove it must not fail the generation.
        if (stagedPaths.length) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("reference cleanup timed out")), Math.max(1_000, Math.min(5_000, timeLeftMs(budget))));
            });
            const { error } = await Promise.race([admin.storage.from('media').remove(stagedPaths), timeout]);
            if (error) throw error;
          } catch (error) {
            console.warn('[generate-image] could not remove staged references:', error instanceof Error ? error.message : String(error));
          } finally {
            clearTimeout(timer);
          }
        }
      }
    },
  };
}
