# AI Agent Setup Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the AI Agent Setup Knowledge tab into three input methods (Manual / Upload / Website) above a pinned Sources panel, split the Settings tab into modular cards whose controls actually reach the model's system prompt, and add Firecrawl website ingestion.

**Architecture:** Both tabs keep their existing container components as the sole owners of state and mutations; the new pieces are presentational children. A structured business profile lives in a new `ai_agent_configs.business_profile` jsonb column and is rendered **server-side** into the existing `business_profile_text`, so the entire ingestion and blanking-guard path is untouched. Website scraping calls Firecrawl `/v2/scrape` inline for one page and `/v2/crawl` + a polling worker for a whole site, reusing the knowledge queue that already exists for spreadsheets.

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind + shadcn/ui, Vitest + @testing-library/react (`fireEvent` only), Supabase self-hosted Postgres 15, Deno edge functions, `deno test`, Firecrawl v2 API.

**Spec:** `docs/superpowers/specs/2026-09-05-agent-setup-restructure-design.md`

## Global Constraints

- **Branch:** `feat/agent-setup-restructure`. Another CLI drives `F:\Postora_new`'s HEAD and the tree carries unrelated dirty files — every commit is scoped: `git commit -m "…" -- <files>`. Never `git stash -u`.
- **`userEvent` is unusable in this repo** (clipboard API). All React tests use `fireEvent`.
- **Run Deno tests BEFORE `bun install`.** `deno test --node-modules-dir=auto` destroys `node_modules` and breaks vitest.
- **The CI edge-test invocation is `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/`.** Locally, run new pure modules with `--node-modules-dir=none` so the run does not wipe `node_modules`; run the full CI form last, then `bun install`.
- **Run `deno check` on every new edge module.** `--no-check` hides type errors that only surface at runtime.
- **Migrations are manual; `main` auto-deploys the frontend.** A frontend naming a column that does not exist yet makes PostgREST reject the **entire row** (PGRST204) — every config save dies, not just the new field. Migrations for Tasks 6 and 13 are applied to production **before** the slice merges.
- **Migrations run as `supabase_admin`**, not `postgres` (mixed table ownership). Apply through `ssh-contabo-mcp`:
  `docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U supabase_admin -d postgres -f <path>`
- **Never rehearse a migration inside the prod container.** Use the PG17 db-harness. An outer `BEGIN`/`ROLLBACK` does not rehearse anything — every Postora migration self-commits.
- **Edge deploy:** `git fetch` in `/root/postora-runtime`, then `docker compose restart <service>`. `up -d` silently serves old code.
- **Never return 5xx for an application error.** Cloudflare masks the origin body; return a 400 with a readable message.
- **Guard passes before each commit:** `clean-code-guard` on changed production code, `test-guard` on changed/added tests.
- **Full frontend gate:** `bun run test` (baseline: all green) and `bunx tsc --noEmit`.

---

## File Structure

**New — frontend**

| File | Responsibility |
|---|---|
| `src/components/messaging/knowledge/KnowledgeSourcesPanel.tsx` | The pinned "Sources in the vector database" list — rows, badges, re-ingest/delete, sharing strip |
| `src/components/messaging/knowledge/KnowledgeGraphCard.tsx` | Graph export buttons |
| `src/components/messaging/knowledge/ManualProfilePanel.tsx` | Structured business-profile fields + Save & index (+ WhatsApp catalog on WhatsApp) |
| `src/components/messaging/knowledge/UploadPanel.tsx` | File dropzone + scope select |
| `src/components/messaging/knowledge/WebsitePanel.tsx` | URL, crawl mode, page cap, Start scraping & indexing |
| `src/components/messaging/agent-settings/AgentIdentityCard.tsx` | Enable, engagement mode, tone, response length, language |
| `src/components/messaging/agent-settings/BusinessGoalsCard.tsx` | Industry + goal checkboxes |
| `src/components/messaging/agent-settings/GuardrailsCard.tsx` | Greeting, free-text instructions, locked-on guard rows |
| `src/components/messaging/agent-settings/HumanHandoffCard.tsx` | Handoff switches + admin phone numbers |
| `src/components/messaging/agent-settings/InstructionBlocksCard.tsx` | Titled instruction blocks |
| `src/components/messaging/agent-settings/AdvancedCard.tsx` | Daily cap, cooldown |
| `src/lib/agentProfile.ts` | Shared client types + option lists for `business_profile` / `agent_behavior` |

**New — backend**

| File | Responsibility |
|---|---|
| `supabase/functions/_shared/businessProfileText.ts` | `BusinessProfile` type, `parseBusinessProfile`, `renderBusinessProfileText` |
| `supabase/functions/_shared/businessProfileText.test.ts` | Deno tests for the above |
| `supabase/functions/_shared/agentBehavior.ts` | `AgentBehavior` type, `parseAgentBehavior` |
| `supabase/functions/_shared/agentBehavior.test.ts` | Deno tests |
| `supabase/functions/_shared/knowledgeUrl.ts` | `validateKnowledgeUrl` (SSRF hardening) |
| `supabase/functions/_shared/knowledgeUrl.test.ts` | Deno tests |
| `supabase/functions/_shared/firecrawl.ts` | Firecrawl v2 client: key resolution, scrape, start crawl, crawl status |
| `supabase/functions/_shared/firecrawl.test.ts` | Deno tests with a stubbed fetch |
| `supabase/migrations/20260905100000_agent_structured_profile.sql` | Migration A |
| `supabase/migrations/20260905110000_knowledge_website_sources.sql` | Migration B + queue cron |

**Modified**

| File | Change |
|---|---|
| `src/components/messaging/AiKnowledgeManager.tsx` | Becomes a container rendering sub-tabs + pinned panels |
| `src/components/messaging/AiAgentManager.tsx` | Settings tab body becomes card components; state machine untouched |
| `src/hooks/useAiAgentConfig.ts` | `AiAgentConfig` gains `business_profile` / `agent_behavior`; `CONFIG_FIELDS` gains both |
| `supabase/functions/messaging-api/index.ts:481` | `allowedFields` gains both; renders `business_profile_text` from `business_profile` |
| `supabase/functions/ai-agent-reply/logic.ts` | `behaviorRules()`; handoff rules become conditional |
| `supabase/functions/ai-agent-reply/index.ts:951` | Passes `behavior` and the two handoff flags to `buildSystemPrompt` |
| `supabase/functions/ai-knowledge-ingest/index.ts` | New `ingest_website` action |
| `supabase/functions/ai-knowledge-excel-worker/index.ts` | Claims and polls `website` sources |
| `src/lib/aiKnowledge.ts` | `website` added to the source-type display mapping |

---

## Slice 1 — Knowledge tab shell

### Task 1: Extract the Sources panel and Graph card

**Files:**
- Create: `src/components/messaging/knowledge/KnowledgeSourcesPanel.tsx`
- Create: `src/components/messaging/knowledge/KnowledgeGraphCard.tsx`
- Modify: `src/components/messaging/AiKnowledgeManager.tsx`
- Test: `src/components/messaging/__tests__/AiKnowledgeManager.sharing.test.tsx` (unmodified — it is the contract)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  // KnowledgeSourcesPanel.tsx
  export interface KnowledgeSourcesPanelProps {
    sources: AiKnowledgeSource[];        // already filtered to this account
    allSourcesCount: number;             // to distinguish "none at all" from "none here"
    isLoading: boolean;
    linksError: unknown;
    accountsError: unknown;
    linksReady: boolean;
    accountsReady: boolean;
    shareAccounts: SharingAccount[];
    sharedBySource: Map<string, string[]>;
    sharingSourceIds: readonly string[];
    socialAccounts: { id: string; platform: string; platform_username: string | null }[];
    busy: boolean;                       // invoke.isPending
    onReingest: (source: AiKnowledgeSource) => void;
    onDelete: (source: AiKnowledgeSource) => void;
    onToggleShare: (source: AiKnowledgeSource, target: SharingAccount, checked: boolean) => void;
  }
  export function KnowledgeSourcesPanel(props: KnowledgeSourcesPanelProps): JSX.Element;

  // KnowledgeGraphCard.tsx
  export interface KnowledgeGraphCardProps {
    graphExport: { html_url: string | null; vault_url: string | null } | null;
    busy: boolean;
    resolving: boolean;
    unresolvable: { html: boolean; vault: boolean };
    onGenerate: () => void;
    onOpen: (kind: "html" | "vault") => void;
  }
  export function KnowledgeGraphCard(props: KnowledgeGraphCardProps): JSX.Element;
  ```

- [ ] **Step 1: Run the existing knowledge tests to record the green baseline**

```bash
bun run test -- src/components/messaging/__tests__/AiKnowledgeManager.guards.test.tsx src/components/messaging/__tests__/AiKnowledgeManager.sharing.test.tsx
```

Expected: PASS. Write the pass count down — it must not change in this task.

- [ ] **Step 2: Create `KnowledgeSourcesPanel.tsx`**

Move the whole `<Card>` whose header is `Sources` out of `AiKnowledgeManager.tsx` (currently lines ~449–612) verbatim, replacing each closed-over value with the prop of the same name from the interface above. Three details are load-bearing and must survive the move exactly:

- The empty state distinguishes `allSourcesCount === 0` ("No knowledge sources yet.") from a non-empty total with an empty visible list ("No sources are available to this account yet.").
- `linksError` renders "Could not check which sources this account can use." **instead of** the list — never an unfiltered list.
- The sharing strip renders only when `linksReady && accountsReady && shareAccounts.length > 1`, and `accountsError` replaces it with its own message.

Rename the header text to `Sources in the vector database` and add a short description: `Everything the agent can actually read. Live status, chunk counts and which agents each source reaches.`

- [ ] **Step 3: Create `KnowledgeGraphCard.tsx`**

Move the `Knowledge graph` card (currently lines ~613–676) verbatim, driven by the props above.

- [ ] **Step 4: Wire both back into `AiKnowledgeManager`**

Replace the two removed cards with:

```tsx
<KnowledgeSourcesPanel
  sources={visibleSources}
  allSourcesCount={sources.length}
  isLoading={isLoading}
  linksError={linksError}
  accountsError={accountsError}
  linksReady={linksReady}
  accountsReady={accountsReady}
  shareAccounts={shareAccounts}
  sharedBySource={sharedBySource}
  sharingSourceIds={sharingSourceIds}
  socialAccounts={socialAccounts}
  busy={invoke.isPending}
  onReingest={(source) =>
    run(
      source.source_type === "profile_text" ? "ingest_profile_text" : "ingest_source",
      source.source_type === "profile_text"
        ? { platform, social_account_id: accountId ?? undefined }
        : { source_id: source.id },
      "Source indexing started",
    )
  }
  onDelete={(source) => run("delete_source", { source_id: source.id }, "Source deleted")}
  onToggleShare={toggleShare}
/>
<KnowledgeGraphCard
  graphExport={graphExport}
  busy={invoke.isPending}
  resolving={resolveExportUrls.isPending}
  unresolvable={unresolvable}
  onGenerate={async () => {
    await run("export_graph", {}, "Knowledge graph exports generated");
    setUnresolvable({ html: false, vault: false });
  }}
  onOpen={openExport}
/>
```

- [ ] **Step 5: Run the knowledge tests again**

```bash
bun run test -- src/components/messaging/__tests__/AiKnowledgeManager.guards.test.tsx src/components/messaging/__tests__/AiKnowledgeManager.sharing.test.tsx
```

Expected: PASS, same count as Step 1. A different count means the extraction changed behaviour.

- [ ] **Step 6: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/messaging/knowledge/KnowledgeSourcesPanel.tsx src/components/messaging/knowledge/KnowledgeGraphCard.tsx src/components/messaging/AiKnowledgeManager.tsx
git commit -m "refactor(knowledge): extract the sources panel and graph card" -- src/components/messaging/knowledge/KnowledgeSourcesPanel.tsx src/components/messaging/knowledge/KnowledgeGraphCard.tsx src/components/messaging/AiKnowledgeManager.tsx
```

---

### Task 2: Three input-method sub-tabs above the pinned Sources panel

**Files:**
- Create: `src/components/messaging/knowledge/ManualProfilePanel.tsx`
- Create: `src/components/messaging/knowledge/UploadPanel.tsx`
- Create: `src/components/messaging/knowledge/WebsitePanel.tsx` (placeholder body in this task)
- Modify: `src/components/messaging/AiKnowledgeManager.tsx`
- Test: `src/components/messaging/__tests__/AiKnowledgeManager.tabs.test.tsx`

**Interfaces:**
- Consumes: `KnowledgeSourcesPanel`, `KnowledgeGraphCard` from Task 1.
- Produces:
  ```ts
  export interface ManualProfilePanelProps {
    profile: string;                 // free text in this slice; structured in Task 9
    onProfileChange: (next: string) => void;
    onSave: () => void;
    saveDisabled: boolean;
    saving: boolean;
    // WhatsApp catalog (rendered only when `catalog` is non-null)
    catalog: { catalog_id: string } | null;
    catalogAccountId: string | null;
    onSyncCatalog: () => void;
    catalogBusy: boolean;
  }
  export interface UploadPanelProps {
    accountId: string | null;
    selectedAccountLabel: string | null;
    uploadScope: "account" | "all";
    onUploadScopeChange: (next: "account" | "all") => void;
    uploading: boolean;
    onFileSelected: (file: File | undefined) => void;
  }
  export interface WebsitePanelProps { disabled?: boolean }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/components/messaging/__tests__/AiKnowledgeManager.tabs.test.tsx`. Copy the mock block from `AiKnowledgeManager.guards.test.tsx` verbatim (same five `vi.mock` calls), then:

```tsx
describe("AiKnowledgeManager input methods", () => {
  beforeEach(() => {
    configValue = { business_profile_text: "we sell shoes" };
    configError = null;
    knowledge = {
      sources: [
        {
          id: "s1",
          file_name: "prices.csv",
          source_type: "csv",
          status: "ready",
          error: null,
          chunk_count: 7,
          visibility: "shared",
          created_at: "2026-09-01T00:00:00Z",
        },
      ],
      links: [],
      linksReady: true,
      linksError: null,
    };
  });

  it("shows the three input methods", () => {
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByRole("tab", { name: /manual/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /upload/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /website/i })).toBeInTheDocument();
  });

  it("keeps the sources panel visible on every input method", () => {
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByText("prices.csv")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /upload/i }));
    expect(screen.getByText("prices.csv")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /website/i }));
    expect(screen.getByText("prices.csv")).toBeInTheDocument();
  });

  it("shows the business profile only on the manual method", () => {
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByPlaceholderText(/describe your business/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /upload/i }));
    expect(screen.queryByPlaceholderText(/describe your business/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test -- src/components/messaging/__tests__/AiKnowledgeManager.tabs.test.tsx
```

Expected: FAIL — `Unable to find role="tab"`.

- [ ] **Step 3: Create the three panel components**

`ManualProfilePanel.tsx` holds the existing `Business profile` card (textarea + `Save & index`) and, below it, the WhatsApp catalog card rendered only when `catalog` is non-null. `UploadPanel.tsx` holds the existing `Upload knowledge file` card verbatim. `WebsitePanel.tsx` for now renders a single disabled card:

```tsx
export function WebsitePanel(_props: WebsitePanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scrape a website</CardTitle>
        <CardDescription>Pull your public pages into the agent's knowledge.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Website scraping is being set up. It arrives in the next release.</p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Restructure `AiKnowledgeManager`'s return**

```tsx
const [method, setMethod] = useState<"manual" | "upload" | "website">("manual");

return (
  <div className="space-y-4">
    <Tabs value={method} onValueChange={(value) => setMethod(value as typeof method)}>
      <TabsList className="h-auto flex-wrap justify-start">
        <TabsTrigger value="manual"><PencilLine className="mr-1.5 h-4 w-4" /> Manual profile</TabsTrigger>
        <TabsTrigger value="upload"><Upload className="mr-1.5 h-4 w-4" /> Upload files</TabsTrigger>
        <TabsTrigger value="website"><Globe className="mr-1.5 h-4 w-4" /> Website scraping</TabsTrigger>
      </TabsList>
      <TabsContent value="manual" className="mt-4"><ManualProfilePanel … /></TabsContent>
      <TabsContent value="upload" className="mt-4"><UploadPanel … /></TabsContent>
      <TabsContent value="website" className="mt-4"><WebsitePanel /></TabsContent>
    </Tabs>

    {/* Pinned: the live mirror of the vector database, visible on every method. */}
    <KnowledgeSourcesPanel … />
    <KnowledgeGraphCard … />
  </div>
);
```

`PencilLine`, `Upload` and `Globe` come from `lucide-react`. The Sources and Graph panels sit **outside** `<Tabs>`, which is what makes them persistent.

- [ ] **Step 5: Run the new test and the two existing ones**

```bash
bun run test -- src/components/messaging/__tests__/AiKnowledgeManager
```

Expected: all PASS.

- [ ] **Step 6: Typecheck and full suite**

```bash
bunx tsc --noEmit && bun run test
```

Expected: no type errors; suite green.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(knowledge): three input methods over a pinned sources panel" -- src/components/messaging/knowledge src/components/messaging/AiKnowledgeManager.tsx src/components/messaging/__tests__/AiKnowledgeManager.tabs.test.tsx
```

---

## Slice 2 — Settings tab cards

### Task 3: Split the Settings form into presentational cards

**Files:**
- Create: `src/components/messaging/agent-settings/AgentIdentityCard.tsx`
- Create: `src/components/messaging/agent-settings/HumanHandoffCard.tsx`
- Create: `src/components/messaging/agent-settings/AdvancedCard.tsx`
- Modify: `src/components/messaging/AiAgentManager.tsx`
- Test: the five existing `src/components/messaging/__tests__/AiAgentManager.*.test.tsx` files, **unmodified**

**Interfaces:**
- Consumes: nothing.
- Produces: every card takes the same shape, so a later task can add one without re-deriving it:
  ```ts
  import type { AiAgentConfigInput } from "@/hooks/useAiAgentConfig";

  export interface AgentCardProps {
    form: AiAgentConfigInput;
    update: <K extends keyof AiAgentConfigInput>(key: K, value: AiAgentConfigInput[K]) => void;
  }

  export function AgentIdentityCard(props: AgentCardProps): JSX.Element;
  export function AdvancedCard(props: AgentCardProps): JSX.Element;

  export interface HumanHandoffCardProps extends AgentCardProps {
    phoneInput: string;
    phoneError: string | null;
    onPhoneInputChange: (next: string) => void;
    onAddPhone: () => void;
    onRemovePhone: (phone: string) => void;
  }
  export function HumanHandoffCard(props: HumanHandoffCardProps): JSX.Element;
  ```

**Hard rule for this task:** `AiAgentManager` keeps `configLoaded`, the populate/merge effect, `mergeUntouchedFields`, `baselineRef`, `loadedAccountId`, the `confirm_clear` computation, `save()`, `useDirtyForm` and the `<fieldset disabled={!configLoaded}>` wrapper **byte-identical**. Those encode three separate production outages (2026-08-28, 2026-08-30, and the account-switch write). This task moves JSX only.

- [ ] **Step 1: Record the green baseline**

```bash
bun run test -- src/components/messaging/__tests__/AiAgentManager
```

Expected: PASS. Note the count.

- [ ] **Step 2: Create `AgentIdentityCard.tsx`**

Move the first `<Card>` (title "AI agent settings") — the enable switch, engagement mode select, and language select. Leave the persona textarea and the admin phone block behind for now; they move in the next two steps. Retitle the card `Agent identity` and give it the description `How the assistant introduces itself and which language it answers in.`

- [ ] **Step 3: Create `HumanHandoffCard.tsx`**

Move the "Admin phone numbers" block into a card of its own titled `Human handoff`, description `Who takes over when the assistant cannot answer.` Keep the `Badge`/`X` chip list, the `Input` + `Add` button, the Enter-key handler, and the `phoneError` paragraph exactly as they are — `addPhone`'s validation stays in the container and is passed as `onAddPhone`.

- [ ] **Step 4: Create `AdvancedCard.tsx`**

Move the existing "Advanced" card (daily cap, cooldown) verbatim.

- [ ] **Step 5: Wire them into the container**

Inside the existing `<fieldset disabled={!configLoaded} className="contents" data-testid="agent-form-fields">`:

```tsx
<AgentIdentityCard form={form} update={update} />
<GuardrailsCard form={form} update={update} />   {/* added in Task 10; omit for now */}
<HumanHandoffCard
  form={form}
  update={update}
  phoneInput={phoneInput}
  phoneError={phoneError}
  onPhoneInputChange={(next) => { setPhoneInput(next); setPhoneError(null); }}
  onAddPhone={addPhone}
  onRemovePhone={(phone) =>
    update("admin_phone_numbers", (form.admin_phone_numbers || []).filter((n) => n !== phone))
  }
/>
<AdvancedCard form={form} update={update} />
```

Keep the persona textarea in the container for this task — it moves into `GuardrailsCard` in Task 10, which is where its new neighbours arrive.

- [ ] **Step 6: Run the five contract tests**

```bash
bun run test -- src/components/messaging/__tests__/AiAgentManager
```

Expected: PASS, same count as Step 1. If any fails, the split touched state — revert the offending move rather than editing the test.

- [ ] **Step 7: Typecheck and commit**

```bash
bunx tsc --noEmit
git commit -m "refactor(agent-settings): split the settings form into cards" -- src/components/messaging/agent-settings src/components/messaging/AiAgentManager.tsx
```

---

## Slice 3 — Structured profile and agent behavior

### Task 4: The business-profile renderer (Deno, TDD)

**Files:**
- Create: `supabase/functions/_shared/businessProfileText.ts`
- Test: `supabase/functions/_shared/businessProfileText.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type BusinessIndustry = "ecommerce" | "clinic" | "b2b_services" | "restaurant" | "other";
  export interface BusinessProfile {
    industry?: BusinessIndustry;
    products?: string;
    policies?: { returns?: string; shipping?: string; warranty?: string };
    faqs?: { q: string; a: string }[];
    notes?: string;
  }
  export class BusinessProfileError extends Error {}
  /** Throws BusinessProfileError on an unknown key, wrong type, or bad enum value. */
  export function parseBusinessProfile(input: unknown): BusinessProfile;
  /** The text the vector database is built from. Empty object -> "". */
  export function renderBusinessProfileText(profile: BusinessProfile): string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BusinessProfileError,
  parseBusinessProfile,
  renderBusinessProfileText,
} from "./businessProfileText.ts";

Deno.test("an empty profile renders to the empty string", () => {
  assertEquals(renderBusinessProfileText({}), "");
});

Deno.test("blank-only fields still render to the empty string", () => {
  // This is what makes confirm_clear fire: a profile the user emptied field by
  // field must look exactly like a cleared textarea to the blanking guard.
  assertEquals(renderBusinessProfileText({ products: "   ", notes: "\n" }), "");
});

Deno.test("sections are labelled and separated by blank lines", () => {
  const text = renderBusinessProfileText({
    industry: "ecommerce",
    products: "Running shoes, trainers",
    policies: { returns: "14 days", shipping: "Free over 20 KWD" },
    faqs: [{ q: "Do you ship abroad?", a: "Yes, GCC only." }],
    notes: "Family business since 1998",
  });
  assertEquals(text.split("\n\n"), [
    "Business type: E-commerce store",
    "Products and services:\nRunning shoes, trainers",
    "Returns policy:\n14 days",
    "Shipping policy:\nFree over 20 KWD",
    "FAQ: Do you ship abroad?\nYes, GCC only.",
    "Additional notes:\nFamily business since 1998",
  ]);
});

Deno.test("each FAQ is its own paragraph so chunkProfileText can split on them", () => {
  const text = renderBusinessProfileText({
    faqs: [{ q: "A?", a: "1" }, { q: "B?", a: "2" }],
  });
  assertEquals(text, "FAQ: A?\n1\n\nFAQ: B?\n2");
});

Deno.test("parse rejects an unknown key by name", () => {
  const error = assertThrows(
    () => parseBusinessProfile({ industry: "clinic", sneaky: 1 }),
    BusinessProfileError,
  );
  assertEquals(error.message, "Unknown business_profile key: sneaky");
});

Deno.test("parse rejects an industry outside the enum", () => {
  assertThrows(() => parseBusinessProfile({ industry: "bakery" }), BusinessProfileError);
});

Deno.test("parse rejects a FAQ entry missing an answer", () => {
  assertThrows(() => parseBusinessProfile({ faqs: [{ q: "A?" }] }), BusinessProfileError);
});

Deno.test("parse accepts an empty object and null", () => {
  assertEquals(parseBusinessProfile({}), {});
  assertEquals(parseBusinessProfile(null), {});
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/_shared/businessProfileText.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
export type BusinessIndustry = "ecommerce" | "clinic" | "b2b_services" | "restaurant" | "other";

const INDUSTRY_LABELS: Record<BusinessIndustry, string> = {
  ecommerce: "E-commerce store",
  clinic: "Clinic or medical practice",
  b2b_services: "B2B services",
  restaurant: "Restaurant or cafe",
  other: "Other",
};

export interface BusinessProfile {
  industry?: BusinessIndustry;
  products?: string;
  policies?: { returns?: string; shipping?: string; warranty?: string };
  faqs?: { q: string; a: string }[];
  notes?: string;
}

export class BusinessProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessProfileError";
  }
}

const PROFILE_KEYS = ["industry", "products", "policies", "faqs", "notes"] as const;
const POLICY_KEYS = ["returns", "shipping", "warranty"] as const;

const asText = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new BusinessProfileError(`${field} must be a string`);
  return value;
};

export function parseBusinessProfile(input: unknown): BusinessProfile {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new BusinessProfileError("business_profile must be an object");
  }
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) {
      throw new BusinessProfileError(`Unknown business_profile key: ${key}`);
    }
  }
  const profile: BusinessProfile = {};
  if ("industry" in source && source.industry !== undefined) {
    const industry = asText(source.industry, "industry");
    if (!(industry in INDUSTRY_LABELS)) {
      throw new BusinessProfileError(`industry must be one of: ${Object.keys(INDUSTRY_LABELS).join(", ")}`);
    }
    profile.industry = industry as BusinessIndustry;
  }
  if ("products" in source && source.products !== undefined) {
    profile.products = asText(source.products, "products");
  }
  if ("notes" in source && source.notes !== undefined) {
    profile.notes = asText(source.notes, "notes");
  }
  if ("policies" in source && source.policies !== undefined) {
    const policies = source.policies;
    if (typeof policies !== "object" || policies === null || Array.isArray(policies)) {
      throw new BusinessProfileError("policies must be an object");
    }
    const parsed: NonNullable<BusinessProfile["policies"]> = {};
    for (const key of Object.keys(policies as Record<string, unknown>)) {
      if (!(POLICY_KEYS as readonly string[]).includes(key)) {
        throw new BusinessProfileError(`Unknown policies key: ${key}`);
      }
      parsed[key as (typeof POLICY_KEYS)[number]] = asText(
        (policies as Record<string, unknown>)[key],
        `policies.${key}`,
      );
    }
    profile.policies = parsed;
  }
  if ("faqs" in source && source.faqs !== undefined) {
    if (!Array.isArray(source.faqs)) throw new BusinessProfileError("faqs must be an array");
    if (source.faqs.length > 50) throw new BusinessProfileError("faqs is limited to 50 entries");
    profile.faqs = source.faqs.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new BusinessProfileError(`faqs[${index}] must be an object`);
      }
      const record = entry as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key !== "q" && key !== "a") throw new BusinessProfileError(`Unknown faqs key: ${key}`);
      }
      return { q: asText(record.q, `faqs[${index}].q`), a: asText(record.a, `faqs[${index}].a`) };
    });
  }
  return profile;
}

/**
 * The paragraph is the unit here because chunkProfileText splits on blank
 * lines. One FAQ per paragraph means a retrieval hit returns that answer
 * rather than an arbitrary window across three unrelated questions.
 */
export function renderBusinessProfileText(profile: BusinessProfile): string {
  const sections: string[] = [];
  const section = (label: string, body?: string) => {
    const trimmed = (body ?? "").trim();
    if (trimmed) sections.push(`${label}:\n${trimmed}`);
  };
  if (profile.industry) sections.push(`Business type: ${INDUSTRY_LABELS[profile.industry]}`);
  section("Products and services", profile.products);
  section("Returns policy", profile.policies?.returns);
  section("Shipping policy", profile.policies?.shipping);
  section("Warranty policy", profile.policies?.warranty);
  for (const faq of profile.faqs ?? []) {
    const question = faq.q.trim();
    const answer = faq.a.trim();
    if (question && answer) sections.push(`FAQ: ${question}\n${answer}`);
  }
  section("Additional notes", profile.notes);
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/_shared/businessProfileText.test.ts
deno check supabase/functions/_shared/businessProfileText.ts
```

Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent): render a structured business profile into indexable text" -- supabase/functions/_shared/businessProfileText.ts supabase/functions/_shared/businessProfileText.test.ts
```

---

### Task 5: The agent-behavior parser (Deno, TDD)

**Files:**
- Create: `supabase/functions/_shared/agentBehavior.ts`
- Test: `supabase/functions/_shared/agentBehavior.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type AgentTone = "friendly_professional" | "formal" | "enthusiastic" | "concise";
  export type AgentResponseLength = "short" | "medium" | "detailed";
  export type AgentGoal = "recommend_products" | "answer_pricing" | "handle_complaints" | "capture_leads";
  export interface AgentBehavior {
    tone?: AgentTone;
    response_length?: AgentResponseLength;
    goals?: AgentGoal[];
    greeting?: string;
    instruction_blocks?: { title: string; body: string }[];
  }
  export class AgentBehaviorError extends Error {}
  export function parseAgentBehavior(input: unknown): AgentBehavior;
  export const AGENT_TONES: readonly AgentTone[];
  export const AGENT_RESPONSE_LENGTHS: readonly AgentResponseLength[];
  export const AGENT_GOALS: readonly AgentGoal[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AgentBehaviorError, parseAgentBehavior } from "./agentBehavior.ts";

Deno.test("null and an empty object both parse to an empty behavior", () => {
  assertEquals(parseAgentBehavior(null), {});
  assertEquals(parseAgentBehavior({}), {});
});

Deno.test("a full behavior round-trips", () => {
  const input = {
    tone: "formal",
    response_length: "short",
    goals: ["capture_leads", "answer_pricing"],
    greeting: "Welcome to Xsellpoint.",
    instruction_blocks: [{ title: "Pricing", body: "Never quote without the connector." }],
  };
  assertEquals(parseAgentBehavior(input), input);
});

Deno.test("an unknown key is named in the error", () => {
  const error = assertThrows(() => parseAgentBehavior({ vibe: "cool" }), AgentBehaviorError);
  assertEquals(error.message, "Unknown agent_behavior key: vibe");
});

Deno.test("an unknown goal is rejected", () => {
  assertThrows(() => parseAgentBehavior({ goals: ["sell_kidneys"] }), AgentBehaviorError);
});

Deno.test("duplicate goals collapse", () => {
  assertEquals(parseAgentBehavior({ goals: ["capture_leads", "capture_leads"] }), {
    goals: ["capture_leads"],
  });
});

Deno.test("more than ten instruction blocks is rejected", () => {
  const blocks = Array.from({ length: 11 }, (_, i) => ({ title: `t${i}`, body: "b" }));
  assertThrows(() => parseAgentBehavior({ instruction_blocks: blocks }), AgentBehaviorError);
});

Deno.test("an instruction block body over 2000 chars is rejected", () => {
  assertThrows(
    () => parseAgentBehavior({ instruction_blocks: [{ title: "t", body: "x".repeat(2001) }] }),
    AgentBehaviorError,
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/_shared/agentBehavior.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

Mirror the structure of `businessProfileText.ts`: an explicit key allow-list, enum membership checks against the exported const arrays, `greeting` capped at 500 characters, `goals` de-duplicated while preserving first-seen order, `instruction_blocks` capped at 10 with `title` ≤ 120 and `body` ≤ 2000 characters, and every rejection naming the offending key.

- [ ] **Step 4: Run the tests and type check**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/_shared/agentBehavior.test.ts
deno check supabase/functions/_shared/agentBehavior.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent): validate the agent behavior object" -- supabase/functions/_shared/agentBehavior.ts supabase/functions/_shared/agentBehavior.test.ts
```

---

### Task 6: Migration A — the two jsonb columns

**Files:**
- Create: `supabase/migrations/20260905100000_agent_structured_profile.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.ai_agent_configs.business_profile jsonb` and `.agent_behavior jsonb`, both `NOT NULL DEFAULT '{}'::jsonb`.

- [ ] **Step 1: Write the migration**

```sql
-- Structured business profile and agent behavior.
--
-- business_profile_text stays the column the vector database is built from;
-- this migration adds the STRUCTURE behind it, which ai_upsert_config renders
-- back into that text. Doing the render server-side is deliberate: the client
-- form is the layer that blanked live personas twice (2026-08-28, 2026-08-30),
-- and confirm_clear/blankedFields only protect business_profile_text.

ALTER TABLE public.ai_agent_configs
  ADD COLUMN IF NOT EXISTS business_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS agent_behavior   jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ai_agent_configs.business_profile IS
  'Structured business profile. Rendered into business_profile_text by ai_upsert_config; never read directly by retrieval.';
COMMENT ON COLUMN public.ai_agent_configs.agent_behavior IS
  'Tone, response length, goals, greeting and instruction blocks. Read by buildSystemPrompt.';

-- Existing free text becomes `notes` so the Manual tab opens pre-filled and no
-- wording is lost. Guarded by business_profile = '{}' so re-running the
-- migration cannot overwrite a profile a user has since filled in.
UPDATE public.ai_agent_configs
SET business_profile = jsonb_build_object('notes', business_profile_text)
WHERE business_profile = '{}'::jsonb
  AND business_profile_text IS NOT NULL
  AND btrim(business_profile_text) <> '';
```

- [ ] **Step 2: Rehearse on the PG17 db-harness**

Follow `docs/runbooks/` for the harness. Apply the file, then assert the backfill:

```sql
SELECT count(*) FROM public.ai_agent_configs
WHERE btrim(coalesce(business_profile_text,'')) <> ''
  AND business_profile->>'notes' IS NULL;
```

Expected: `0`.

- [ ] **Step 3: Apply to production**

```bash
# via ssh-contabo-mcp
docker cp <local>/20260905100000_agent_structured_profile.sql \
  postorasupabase-supabase-j8axyh-supabase-db:/tmp/m.sql
docker exec postorasupabase-supabase-j8axyh-supabase-db \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/m.sql
```

Then force a PostgREST schema reload — an applied column stays invisible to the API until it reloads:

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db \
  psql -U supabase_admin -d postgres -c "NOTIFY pgrst, 'reload schema';"
```

- [ ] **Step 4: Verify in production**

```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='ai_agent_configs'
  AND column_name IN ('business_profile','agent_behavior');
```

Expected: two rows.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(db): structured business profile and agent behavior columns" -- supabase/migrations/20260905100000_agent_structured_profile.sql
```

---

### Task 7: Server-side render on save

**Files:**
- Modify: `supabase/functions/messaging-api/index.ts` (the `ai_upsert_config` action, ~line 475)
- Test: `supabase/functions/messaging-api/configBlanking.test.ts` (add cases)

**Interfaces:**
- Consumes: `parseBusinessProfile`, `renderBusinessProfileText` (Task 4); `parseAgentBehavior` (Task 5).
- Produces: `ai_upsert_config` accepts `business_profile` and `agent_behavior`, and derives `business_profile_text` whenever `business_profile` is present.

- [ ] **Step 1: Write the failing test**

Append to `configBlanking.test.ts`:

```ts
import { renderBusinessProfileText } from "../_shared/businessProfileText.ts";
import { blankedFields } from "./configBlanking.ts";

Deno.test("a profile emptied field by field still trips the blanking guard", () => {
  // The user cleared every structured field. The rendered text is "", and the
  // stored text is not -- which is exactly the shape confirm_clear exists for.
  const updates = { business_profile_text: renderBusinessProfileText({ products: "  " }) };
  assertEquals(blankedFields(updates, { business_profile_text: "we sell shoes" }), [
    "business_profile_text",
  ]);
});

Deno.test("a filled structured profile does not trip the guard", () => {
  const updates = { business_profile_text: renderBusinessProfileText({ products: "shoes" }) };
  assertEquals(blankedFields(updates, { business_profile_text: "we sell shoes" }), []);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/messaging-api/configBlanking.test.ts
```

Expected: FAIL — the import of `businessProfileText.ts` resolves, but the first case fails only if the renderer misbehaves; if both already pass, that is the correct outcome and the value of the test is regression coverage. Record which.

- [ ] **Step 3: Extend `allowedFields` and add the render**

In `supabase/functions/messaging-api/index.ts`, add the two names to `allowedFields`:

```ts
const allowedFields = [
  "is_enabled", "default_mode", "persona_instructions", "business_profile_text",
  "language_mode", "model", "fallback_model_1", "fallback_model_2",
  "temperature", "admin_phone_numbers",
  "daily_message_cap", "reply_cooldown_seconds", "max_tool_iterations",
  "handoff_on_request", "handoff_on_low_confidence",
  "business_profile", "agent_behavior",
];
```

Then, immediately after the `admin_phone_numbers` normalisation block and **before** the model allow-list check:

```ts
// The structured profile is the input; business_profile_text is the derived
// column the vector database is built from. Rendering here rather than in the
// browser keeps one producer for the field every blanking guard protects --
// the client form is the layer that emptied live profiles twice.
if ("business_profile" in updates) {
  try {
    const profile = parseBusinessProfile(updates.business_profile);
    updates.business_profile = profile;
    // A caller sending both is sending a contradiction; the structure wins,
    // because it is what the form will show them next time.
    updates.business_profile_text = renderBusinessProfileText(profile);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Invalid business_profile" }, 400);
  }
}
if ("agent_behavior" in updates) {
  try {
    updates.agent_behavior = parseAgentBehavior(updates.agent_behavior);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Invalid agent_behavior" }, 400);
  }
}
```

Add the two imports at the top of the file.

- [ ] **Step 4: Run the messaging-api Deno tests and type-check**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/messaging-api/
deno check supabase/functions/messaging-api/index.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(messaging-api): accept a structured profile and render its text" -- supabase/functions/messaging-api/index.ts supabase/functions/messaging-api/configBlanking.test.ts
```

---

### Task 8: Behavior reaches the system prompt

**Files:**
- Modify: `supabase/functions/ai-agent-reply/logic.ts` (`buildSystemPrompt`, ~line 255)
- Modify: `supabase/functions/ai-agent-reply/index.ts` (~line 951)
- Test: `supabase/functions/ai-agent-reply/tools.test.ts`

**Interfaces:**
- Consumes: `AgentBehavior` (Task 5).
- Produces: `SystemPromptParams` gains `behavior?: AgentBehavior | null`, `handoffOnRequest?: boolean`, `handoffOnLowConfidence?: boolean`. New exported `behaviorRules(behavior): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `tools.test.ts`, matching the existing style there:

```ts
Deno.test("a configured tone and length reach the prompt", async () => {
  const { buildSystemPrompt } = await import("./logic.ts");
  const prompt = buildSystemPrompt({
    persona: "",
    knowledgeBlocks: [],
    nowIso: "2026-09-05T00:00:00Z",
    language: "en",
    languageForced: false,
    behavior: { tone: "formal", response_length: "short" },
  });
  assertStringIncludes(prompt, "formal");
  assertStringIncludes(prompt, "one or two sentences");
});

Deno.test("goals render as objectives", async () => {
  const { buildSystemPrompt } = await import("./logic.ts");
  const prompt = buildSystemPrompt({
    persona: "",
    knowledgeBlocks: [],
    nowIso: "2026-09-05T00:00:00Z",
    language: "en",
    languageForced: false,
    behavior: { goals: ["capture_leads"] },
  });
  assertStringIncludes(prompt, "Your objectives");
  assertStringIncludes(prompt, "contact details");
});

Deno.test("instruction blocks render with their titles", async () => {
  const { buildSystemPrompt } = await import("./logic.ts");
  const prompt = buildSystemPrompt({
    persona: "",
    knowledgeBlocks: [],
    nowIso: "2026-09-05T00:00:00Z",
    language: "en",
    languageForced: false,
    behavior: { instruction_blocks: [{ title: "Pricing", body: "Always check the connector." }] },
  });
  assertStringIncludes(prompt, "Pricing");
  assertStringIncludes(prompt, "Always check the connector.");
});

Deno.test("the hallucination guard is present with no behavior at all", async () => {
  // Regression lock: behavior is additive. The 2026-09-01 guard must survive
  // an empty, absent, or malformed behavior object.
  const { buildSystemPrompt } = await import("./logic.ts");
  for (const behavior of [undefined, null, {}]) {
    const prompt = buildSystemPrompt({
      persona: "",
      knowledgeBlocks: [],
      nowIso: "2026-09-05T00:00:00Z",
      language: "en",
      languageForced: false,
      behavior,
    });
    assertStringIncludes(prompt, "Never invent prices, availability, or policies.");
  }
});

Deno.test("handoff rules disappear only when both switches are off", async () => {
  const { buildSystemPrompt } = await import("./logic.ts");
  const base = {
    persona: "",
    knowledgeBlocks: [],
    nowIso: "2026-09-05T00:00:00Z",
    language: "en" as const,
    languageForced: false,
  };
  // Default (both undefined) keeps today's behaviour.
  assertStringIncludes(buildSystemPrompt(base), "escalate_to_human");
  const off = buildSystemPrompt({ ...base, handoffOnRequest: false, handoffOnLowConfidence: false });
  assertEquals(off.includes("escalate_to_human"), false);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/ai-agent-reply/tools.test.ts
```

Expected: FAIL on the new cases.

- [ ] **Step 3: Implement `behaviorRules` and wire it in**

In `logic.ts`, above `buildSystemPrompt`:

```ts
const TONE_RULES: Record<AgentTone, string> = {
  friendly_professional: "Write in a warm but professional tone — helpful, never casual to the point of sloppiness.",
  formal: "Write in a formal, courteous tone. No slang, no emoji.",
  enthusiastic: "Write with energy and enthusiasm about the products, without overpromising.",
  concise: "Write plainly and get to the point. No filler, no restating the question.",
};

const LENGTH_RULES: Record<AgentResponseLength, string> = {
  short: "Keep replies to one or two sentences unless the customer asks for detail.",
  medium: "Keep replies to a short paragraph.",
  detailed: "Give a complete answer, with steps or a short list when that is clearer.",
};

const GOAL_RULES: Record<AgentGoal, string> = {
  recommend_products: "Suggest the products that fit what the customer described, and help them decide.",
  answer_pricing: "Answer price, stock and availability questions from the knowledge or a connector — never from memory.",
  handle_complaints: "Acknowledge complaints before answering them, and never argue with the customer.",
  capture_leads: "When the conversation is going well, ask for the customer's name and contact details so the team can follow up.",
};

/**
 * The business's own configuration, rendered as prompt lines. Additive by
 * construction: an empty behavior contributes nothing, so every rule that
 * existed before this function is unchanged for every existing config.
 */
export function behaviorRules(behavior?: AgentBehavior | null): string[] {
  if (!behavior) return [];
  const lines: string[] = [];
  if (behavior.tone) lines.push(TONE_RULES[behavior.tone]);
  if (behavior.response_length) lines.push(LENGTH_RULES[behavior.response_length]);
  if (behavior.goals?.length) {
    lines.push(
      ["Your objectives in this conversation:", ...behavior.goals.map((goal) => `- ${GOAL_RULES[goal]}`)].join("\n"),
    );
  }
  if (behavior.greeting?.trim()) {
    lines.push(`If this is your first reply in the conversation, open with: ${behavior.greeting.trim()}`);
  }
  for (const block of behavior.instruction_blocks ?? []) {
    if (block.title.trim() && block.body.trim()) {
      lines.push(`${block.title.trim()}:\n${block.body.trim()}`);
    }
  }
  return lines;
}
```

In `buildSystemPrompt`, insert the block between the persona and `"Rules:"`:

```ts
    params.persona ? `Business persona and instructions:\n${params.persona}` : "",
    ...behaviorRules(params.behavior),
    languageInstruction,
    "Rules:",
```

and make the two handoff rules conditional (defaulting to the column defaults, so nothing changes for an existing config):

```ts
    (params.handoffOnLowConfidence ?? true)
      ? "- If the knowledge does not contain the answer, say you will check with the team, and use the escalate_to_human tool."
      // With the switch off nobody is notified, so the off-variant must not
      // promise a follow-up: escalateConversation is the only thing that
      // reaches a human, and it is exactly what this branch skips.
      : "- If the knowledge does not contain the answer, say plainly that you do not have that information. Do not promise that anyone will follow up.",
    (params.handoffOnRequest ?? true)
      ? "- If the customer asks for a person/human/agent, use the escalate_to_human tool and tell them someone will follow up."
      : "",
```

In `index.ts` at the `buildSystemPrompt({ … })` call, add:

```ts
      behavior: config.agent_behavior,
      handoffOnRequest: config.handoff_on_request,
      handoffOnLowConfidence: config.handoff_on_low_confidence,
```

- [ ] **Step 4: Run all the ai-agent-reply Deno tests**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/ai-agent-reply/
deno check supabase/functions/ai-agent-reply/logic.ts supabase/functions/ai-agent-reply/index.ts
```

Expected: PASS, including every pre-existing `buildSystemPrompt` case.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent-reply): tone, length, goals and handoff switches reach the prompt" -- supabase/functions/ai-agent-reply/logic.ts supabase/functions/ai-agent-reply/index.ts supabase/functions/ai-agent-reply/tools.test.ts
```

---

### Task 9: Client types and the structured Manual panel

**Files:**
- Create: `src/lib/agentProfile.ts`
- Modify: `src/hooks/useAiAgentConfig.ts`
- Modify: `src/components/messaging/knowledge/ManualProfilePanel.tsx`
- Modify: `src/components/messaging/AiKnowledgeManager.tsx`
- Test: `src/components/messaging/__tests__/AiKnowledgeManager.profile.test.tsx`

**Interfaces:**
- Consumes: Migration A (Task 6), the server render (Task 7).
- Produces:
  ```ts
  // src/lib/agentProfile.ts — mirrors the Deno types so both sides agree.
  export type BusinessIndustry = "ecommerce" | "clinic" | "b2b_services" | "restaurant" | "other";
  export interface BusinessProfile { /* identical to the Deno shape */ }
  export type AgentTone = "friendly_professional" | "formal" | "enthusiastic" | "concise";
  export type AgentResponseLength = "short" | "medium" | "detailed";
  export type AgentGoal = "recommend_products" | "answer_pricing" | "handle_complaints" | "capture_leads";
  export interface AgentBehavior { /* identical to the Deno shape */ }
  export const INDUSTRY_OPTIONS: { value: BusinessIndustry; label: string }[];
  export const TONE_OPTIONS: { value: AgentTone; label: string; hint: string }[];
  export const RESPONSE_LENGTH_OPTIONS: { value: AgentResponseLength; label: string }[];
  export const GOAL_OPTIONS: { value: AgentGoal; label: string }[];
  ```

- [ ] **Step 1: Write the failing test**

`src/components/messaging/__tests__/AiKnowledgeManager.profile.test.tsx`, reusing the mock block from the guards test:

```tsx
it("saves the structured fields, not a textarea blob", () => {
  configValue = { business_profile: { products: "shoes" }, business_profile_text: "Products…" };
  render(<AiKnowledgeManager platform="facebook" accountId="a1" />);

  fireEvent.change(screen.getByLabelText(/products and services/i), {
    target: { value: "shoes and bags" },
  });
  fireEvent.change(screen.getByLabelText(/returns/i), { target: { value: "14 days" } });
  fireEvent.click(screen.getByRole("button", { name: /save & index/i }));

  expect(upsertConfig.mutateAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      business_profile: { products: "shoes and bags", policies: { returns: "14 days" } },
    }),
  );
});

it("declares the clear when every field is emptied over a stored profile", () => {
  configValue = { business_profile: { products: "shoes" }, business_profile_text: "Products…" };
  render(<AiKnowledgeManager platform="facebook" accountId="a1" />);

  fireEvent.change(screen.getByLabelText(/products and services/i), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /save & index/i }));

  expect(upsertConfig.mutateAsync).toHaveBeenCalledWith(
    expect.objectContaining({ confirm_clear: true }),
  );
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
bun run test -- src/components/messaging/__tests__/AiKnowledgeManager.profile.test.tsx
```

Expected: FAIL — no `Products and services` label.

- [ ] **Step 3: Create `src/lib/agentProfile.ts`**

Copy the type shapes verbatim from the Deno modules and add the four option arrays with user-facing labels. Add a comment at the top pointing at `supabase/functions/_shared/businessProfileText.ts` and `agentBehavior.ts` as the authority — a divergence here produces a 400 from the server's key allow-list, which is the intended failure mode but a confusing one to debug.

- [ ] **Step 4a: Extend the Settings form's value shape**

`AiAgentManager` holds two definitions of "the config as the form sees it", and
both must learn `agent_behavior` or `mergeUntouchedFields` and `useDirtyForm`
will compare `undefined` against `{}` and disagree about whether the field was
touched:

```ts
// defaultConfig
  agent_behavior: {},
// toFormValues
    agent_behavior: config.agent_behavior ?? {},
```

**`business_profile` deliberately goes into NEITHER.** Settings has no UI for it,
and carrying it would make Settings a second writer able to revert what the
Knowledge tab just saved.

For the same reason, **remove `business_profile_text` from `toFormValues` and
`defaultConfig`** in this step. Settings has never rendered that field, so
sending it back on every save is a write with no author — and once the Knowledge
tab writes structure instead of text, a Settings save carrying stale text is a
divergence between the jsonb and the column rendered from it. Verified safe: the
five contract tests all assert with `expect.objectContaining`, so an added or
removed key does not break them. Re-run them immediately after this step.

- [ ] **Step 4b: Extend `useAiAgentConfig.ts`**

Add to the `AiAgentConfig` interface:

```ts
  business_profile: BusinessProfile;
  agent_behavior: AgentBehavior;
```

and to `CONFIG_FIELDS`:

```ts
  "business_profile",
  "agent_behavior",
```

`business_profile_text` stays in `CONFIG_FIELDS` — the Settings form never sends it, and the server overwrites it whenever `business_profile` is present.

- [ ] **Step 5: Rewrite `ManualProfilePanel` around the structured fields**

Fields, in order, each with an explicit `<Label htmlFor>` so the test's `getByLabelText` works:

| Control | Key |
|---|---|
| Select "Business type" | `industry` |
| Textarea "Products and services" (4 rows) | `products` |
| Textarea "Returns policy" (2 rows) | `policies.returns` |
| Textarea "Shipping policy" (2 rows) | `policies.shipping` |
| Textarea "Warranty policy" (2 rows) | `policies.warranty` |
| Repeating Question/Answer pairs with Add and Remove | `faqs` |
| Textarea "Additional notes" (4 rows) | `notes` |

Below them, a read-only collapsible "Preview what the AI will read" rendering the client mirror of `renderBusinessProfileText` — label it clearly as a preview, since the server is the authority.

The panel takes `profile: BusinessProfile` and `onProfileChange: (next: BusinessProfile) => void`, and omits an empty `policies` object rather than sending `{}` — an all-blank `policies` would render nothing anyway, but sending the empty object makes diffs noisy.

- [ ] **Step 6: Update `AiKnowledgeManager`'s save path**

Replace the `profile` string state with `BusinessProfile` state derived from `config?.business_profile`, and change `saveProfile`:

```tsx
const storedText = config?.business_profile_text || "";
const renderedText = renderBusinessProfileTextClient(profile);
// Same asymmetry as before: an empty render over a stored value is the user
// having cleared it, and only that combination is a real clear.
const wouldBlankStoredProfile = renderedText.trim() === "" && storedText.trim() !== "";

const saveProfile = async () => {
  try {
    await upsertConfig.mutateAsync({
      business_profile: profile,
      confirm_clear: wouldBlankStoredProfile || undefined,
    });
    await run("ingest_profile_text", { platform, social_account_id: accountId ?? undefined }, "Business profile indexed");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not save business profile");
  }
};
```

- [ ] **Step 7: Run every knowledge test**

```bash
bun run test -- src/components/messaging/__tests__/AiKnowledgeManager
```

Expected: PASS. `AiKnowledgeManager.guards.test.tsx` asserts on `getByPlaceholderText(/describe your business/i)` — keep that placeholder on the "Additional notes" textarea so the existing guard test keeps testing the same thing.

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
bunx tsc --noEmit && bun run test
git commit -m "feat(knowledge): structured business profile fields" -- src/lib/agentProfile.ts src/hooks/useAiAgentConfig.ts src/components/messaging/knowledge src/components/messaging/AiKnowledgeManager.tsx src/components/messaging/__tests__/AiKnowledgeManager.profile.test.tsx
```

---

### Task 10: The behavior cards

**Files:**
- Create: `src/components/messaging/agent-settings/BusinessGoalsCard.tsx`
- Create: `src/components/messaging/agent-settings/GuardrailsCard.tsx`
- Create: `src/components/messaging/agent-settings/InstructionBlocksCard.tsx`
- Modify: `src/components/messaging/agent-settings/AgentIdentityCard.tsx`
- Modify: `src/components/messaging/agent-settings/HumanHandoffCard.tsx`
- Modify: `src/components/messaging/AiAgentManager.tsx`
- Test: `src/components/messaging/__tests__/AiAgentManager.behavior.test.tsx`

**Interfaces:**
- Consumes: `AgentCardProps` (Task 3), `src/lib/agentProfile.ts` (Task 9), the parser (Task 5), the prompt wiring (Task 8).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

```tsx
it("writes tone and length into agent_behavior without clobbering the rest", () => {
  // The behavior object is one column: a card that replaces it instead of
  // merging would silently drop the goals the previous card just set.
  renderManagerWithConfig({ agent_behavior: { goals: ["capture_leads"] } });

  fireEvent.click(screen.getByRole("radio", { name: /formal/i }));
  fireEvent.click(screen.getByRole("radio", { name: /short/i }));
  fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

  expect(upsertConfig.mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      agent_behavior: { goals: ["capture_leads"], tone: "formal", response_length: "short" },
    }),
    expect.anything(),
  );
});

it("shows the hallucination guard as always on, not as a switch", () => {
  renderManagerWithConfig({});
  const guard = screen.getByTestId("guard-strict-knowledge");
  expect(guard).toHaveTextContent(/always on/i);
  expect(within(guard).queryByRole("switch")).toBeNull();
});
```

Model `renderManagerWithConfig` on the setup in `AiAgentManager.test.tsx`.

- [ ] **Step 2: Run and watch it fail**

```bash
bun run test -- src/components/messaging/__tests__/AiAgentManager.behavior.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Add a behavior updater to the container**

In `AiAgentManager.tsx`, next to `update`:

```tsx
// Merges rather than replaces: agent_behavior is one column written by four
// different cards, and a replacing setter would make the last card win.
const updateBehavior = <K extends keyof AgentBehavior>(key: K, value: AgentBehavior[K]) => {
  setForm((current) => ({
    ...current,
    agent_behavior: { ...(current.agent_behavior ?? {}), [key]: value },
  }));
};
```

Pass `behavior={form.agent_behavior ?? {}}` and `updateBehavior` to every card that needs them.

- [ ] **Step 4: Build the cards**

- **`AgentIdentityCard`** gains a Tone radio group (`RadioGroup` from shadcn, four options from `TONE_OPTIONS`, each with its hint as helper text) and a Response length radio group (`RESPONSE_LENGTH_OPTIONS`), both writing through `updateBehavior`.
- **`BusinessGoalsCard`** — title `What this agent is for`, a `Checkbox` per `GOAL_OPTIONS` entry, writing an array through `updateBehavior("goals", …)`.
- **`GuardrailsCard`** — title `Behaviour and guardrails`. Holds:
  - `greeting` — Input, "First message the assistant opens with".
  - `persona_instructions` — the existing Textarea, relabelled `Additional instructions (free text)`, still writing through `update`.
  - Two locked rows, each a bordered div with a `CheckCircle2`, a title, a sentence, and an `Always on` badge — **no `Switch`**:
    - `data-testid="guard-strict-knowledge"`: "Answers only from your knowledge — the assistant never invents prices, stock or policies. Always on."
    - `data-testid="guard-admits-unknown"`: "Says it will check with the team rather than guessing. Always on."
  - A short note under them: `These two cannot be turned off. They are what stops the assistant inventing an answer.`
- **`InstructionBlocksCard`** — title `Advanced instruction blocks`, a repeating Title/Body pair with Add and Remove, capped at 10 with the Add button disabled at the cap and a note saying so.
- **`HumanHandoffCard`** gains two real `Switch`es above the phone list: `handoff_on_request` ("Hand off when the customer asks for a person") and `handoff_on_low_confidence` ("Hand off when the assistant cannot answer"), both writing through `update`. A note under the phone list: `These numbers are notified when a conversation is handed off.`

- [ ] **Step 5: Order the cards in the container**

```tsx
<AgentIdentityCard … />
<BusinessGoalsCard … />
<GuardrailsCard … />
<HumanHandoffCard … />
<InstructionBlocksCard … />
<AdvancedCard … />
```

- [ ] **Step 6: Run every Settings test**

```bash
bun run test -- src/components/messaging/__tests__/AiAgentManager
```

Expected: PASS, including all five originals.

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
bunx tsc --noEmit && bun run test
git commit -m "feat(agent-settings): tone, goals, guardrails, handoff and instruction blocks" -- src/components/messaging/agent-settings src/components/messaging/AiAgentManager.tsx src/components/messaging/__tests__/AiAgentManager.behavior.test.tsx
```

- [ ] **Step 8: Deploy the edge functions for slice 3**

Order matters, and it is not the obvious one:

1. The migration is already applied (Task 6) — a frontend naming a missing
   column kills every save.
2. **Merge the branch.** `.github/workflows/deploy-edge-functions.yml` deploys
   the edge functions from `main` on its own.
3. Only if Actions is billing-blocked (check the last workflow run before
   assuming either way — a job failing in ~3s with no steps is billing, not the
   diff) fall back to the manual runbook, and check out **`origin/main`**, never
   the feature branch:

```bash
# fallback only
cd /root/postora-runtime && git fetch origin && git checkout -q origin/main -- supabase/functions
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh && docker compose restart functions
```

Checking a feature branch onto `/root/postora-runtime` leaves it dirty against
`main`, and the next auto-deploy fetch conflicts.

Then confirm a save round-trips: open `/automation/agent-setup?platform=whatsapp`, set a tone, save, reload, and check the tone came back.

---

## Slice 4 — Firecrawl website ingestion

### Task 11: URL validation (Deno, TDD)

**Files:**
- Create: `supabase/functions/_shared/knowledgeUrl.ts`
- Test: `supabase/functions/_shared/knowledgeUrl.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };
  export function validateKnowledgeUrl(raw: unknown): UrlCheck;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateKnowledgeUrl } from "./knowledgeUrl.ts";

Deno.test("accepts a plain https URL and normalises it", () => {
  assertEquals(validateKnowledgeUrl("https://xsellpoint.com/shop"), {
    ok: true,
    url: "https://xsellpoint.com/shop",
  });
});

Deno.test("rejects http", () => {
  assertEquals(validateKnowledgeUrl("http://xsellpoint.com").ok, false);
});

Deno.test("rejects a non-http scheme", () => {
  for (const raw of ["file:///etc/passwd", "ftp://x.com", "javascript:alert(1)", "data:text/html,x"]) {
    assertEquals(validateKnowledgeUrl(raw).ok, false, raw);
  }
});

Deno.test("rejects credentials in the URL", () => {
  assertEquals(validateKnowledgeUrl("https://user:pass@xsellpoint.com").ok, false);
});

Deno.test("rejects private, loopback, link-local and metadata hosts", () => {
  for (const host of [
    "localhost", "127.0.0.1", "0.0.0.0", "10.1.2.3", "192.168.0.5",
    "172.16.0.1", "169.254.169.254", "[::1]", "[fd00::1]", "internal", "db.local",
  ]) {
    assertEquals(validateKnowledgeUrl(`https://${host}/x`).ok, false, host);
  }
});

Deno.test("rejects a non-string and an unparseable string", () => {
  assertEquals(validateKnowledgeUrl(42).ok, false);
  assertEquals(validateKnowledgeUrl("not a url").ok, false);
});

Deno.test("rejects a URL longer than 2048 characters", () => {
  assertEquals(validateKnowledgeUrl(`https://x.com/${"a".repeat(2100)}`).ok, false);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/_shared/knowledgeUrl.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

Parse with `new URL`, inside a try. Reject: any protocol but `https:`, any `username` or `password`, a hostname that is `localhost`, ends in `.local` or `.internal`, has no dot at all, or parses as a private/loopback/link-local IPv4 (`10.`, `127.`, `0.`, `169.254.`, `192.168.`, `172.16–31.`) or a loopback/unique-local IPv6 (`::1`, `fc00::/7`). Reject a length over 2048. Return the normalised `url.toString()` with any hash stripped.

Note in a comment that this does **not** defeat DNS rebinding — Firecrawl performs the fetch, and a public hostname resolving to a private address is Firecrawl's egress boundary, not ours. The same known limit is documented for the n8n node's `safeFetchAndStage`.

- [ ] **Step 4: Run and type check**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/_shared/knowledgeUrl.test.ts
deno check supabase/functions/_shared/knowledgeUrl.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(knowledge): validate scrape URLs before they reach Firecrawl" -- supabase/functions/_shared/knowledgeUrl.ts supabase/functions/_shared/knowledgeUrl.test.ts
```

---

### Task 12: The Firecrawl client (Deno, TDD)

**Files:**
- Create: `supabase/functions/_shared/firecrawl.ts`
- Test: `supabase/functions/_shared/firecrawl.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface FirecrawlPage { url: string; title: string; markdown: string }
  export interface CrawlStatus {
    state: "running" | "completed" | "failed";
    completed: number;
    total: number;
    pages: FirecrawlPage[];
    error?: string;
  }
  export class FirecrawlError extends Error {}
  /** env FIRECRAWL_API_KEY, then provider_api_keys. Throws FirecrawlError when absent. */
  export function resolveFirecrawlKey(admin: unknown): Promise<string>;
  export function firecrawlScrape(key: string, url: string, fetchImpl?: typeof fetch): Promise<FirecrawlPage>;
  export function firecrawlStartCrawl(key: string, url: string, limit: number, fetchImpl?: typeof fetch): Promise<string>;
  export function firecrawlCrawlStatus(key: string, jobId: string, fetchImpl?: typeof fetch): Promise<CrawlStatus>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FirecrawlError, firecrawlCrawlStatus, firecrawlScrape, firecrawlStartCrawl } from "./firecrawl.ts";

const stub = (body: unknown, status = 200): typeof fetch =>
  (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

Deno.test("scrape returns the markdown and title", async () => {
  const page = await firecrawlScrape(
    "k",
    "https://x.com",
    stub({ success: true, data: { markdown: "# Hi", metadata: { title: "Hi", sourceURL: "https://x.com" } } }),
  );
  assertEquals(page, { url: "https://x.com", title: "Hi", markdown: "# Hi" });
});

Deno.test("a 200 carrying success:false is a failure, not a page", async () => {
  // The provider returns 200 with the error in the body. Six other Postora
  // functions read that as success; this one must not.
  await assertRejects(
    () => firecrawlScrape("k", "https://x.com", stub({ success: false, error: "credit limit reached" })),
    FirecrawlError,
    "credit limit reached",
  );
});

Deno.test("a 200 with no markdown at all is a failure", async () => {
  await assertRejects(
    () => firecrawlScrape("k", "https://x.com", stub({ success: true, data: {} })),
    FirecrawlError,
  );
});

Deno.test("a non-2xx is a failure naming the status", async () => {
  await assertRejects(
    () => firecrawlScrape("k", "https://x.com", stub({ error: "nope" }, 402)),
    FirecrawlError,
    "402",
  );
});

Deno.test("startCrawl returns the job id", async () => {
  assertEquals(
    await firecrawlStartCrawl("k", "https://x.com", 50, stub({ success: true, id: "job-1" })),
    "job-1",
  );
});

Deno.test("crawl status maps scraping to running and completed to completed", async () => {
  const running = await firecrawlCrawlStatus("k", "j", stub({ status: "scraping", completed: 3, total: 10, data: [] }));
  assertEquals(running.state, "running");
  assertEquals(running.completed, 3);

  const done = await firecrawlCrawlStatus(
    "k",
    "j",
    stub({
      status: "completed",
      completed: 2,
      total: 2,
      data: [
        { markdown: "a", metadata: { title: "A", sourceURL: "https://x.com/a" } },
        { markdown: "b", metadata: { title: "B", sourceURL: "https://x.com/b" } },
      ],
    }),
  );
  assertEquals(done.state, "completed");
  assertEquals(done.pages.length, 2);
  assertEquals(done.pages[0].url, "https://x.com/a");
});

Deno.test("crawl status maps failed and carries the reason", async () => {
  const failed = await firecrawlCrawlStatus("k", "j", stub({ status: "failed", error: "blocked by robots" }));
  assertEquals(failed.state, "failed");
  assertEquals(failed.error, "blocked by robots");
});

Deno.test("a page with no markdown is dropped, not passed on as empty", async () => {
  const done = await firecrawlCrawlStatus(
    "k",
    "j",
    stub({ status: "completed", completed: 2, total: 2, data: [{ markdown: "a", metadata: {} }, { metadata: {} }] }),
  );
  assertEquals(done.pages.length, 1);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/_shared/firecrawl.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

Endpoints: `POST https://api.firecrawl.dev/v2/scrape` with `{ url, formats: ["markdown"], onlyMainContent: true }`; `POST /v2/crawl` with `{ url, limit, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }`; `GET /v2/crawl/{id}`. Auth is `Authorization: Bearer <key>`.

Every response goes through one shared reader that throws `FirecrawlError` when the status is not 2xx (message includes the status and the body's `error`, truncated to 300 chars) **and** when a 2xx body has `success === false`. `resolveFirecrawlKey` reads `Deno.env.get("FIRECRAWL_API_KEY")` first, then `provider_api_keys` where `provider_code = 'firecrawl'`, and throws `FirecrawlError("Firecrawl is not configured. Add its API key in Admin → Settings → AI Providers.")` when neither has one.

- [ ] **Step 4: Run and type check**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/_shared/firecrawl.test.ts
deno check supabase/functions/_shared/firecrawl.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(knowledge): Firecrawl v2 client" -- supabase/functions/_shared/firecrawl.ts supabase/functions/_shared/firecrawl.test.ts
```

---

### Task 13: Migration B — website sources, the queue predicate, and the missing cron

**Files:**
- Create: `supabase/migrations/20260905110000_knowledge_website_sources.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `ai_knowledge_sources.metadata jsonb`; `source_type` accepts `'website'`; `claim_ai_knowledge_excel_source()` claims website sources with `queued_at IS NOT NULL`; cron job `drain-ai-knowledge-queue` every 2 minutes.

- [ ] **Step 1: Write the migration**

```sql
-- Website sources, plus the cron that has been missing since the knowledge
-- queue shipped.
--
-- Verified 2026-09-05 on production: cron.job holds only
-- prune-ai-knowledge-graph-daily, and the standalone EXCEL_WORKER_POLL
-- container is not running -- so nothing drains the queue at all. There are
-- zero pending rows today, so this strands nothing; without it, every queued
-- crawl would sit forever.

ALTER TABLE public.ai_knowledge_sources
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ai_knowledge_sources.metadata IS
  'Source-type specific state. Website sources carry {url, mode, crawl_job_id, stage, pages_done, pages_total}.';

ALTER TABLE public.ai_knowledge_sources
  DROP CONSTRAINT IF EXISTS ai_knowledge_sources_source_type_check;
ALTER TABLE public.ai_knowledge_sources
  ADD CONSTRAINT ai_knowledge_sources_source_type_check
    CHECK (source_type IN ('excel','csv','pdf','doc','image','catalog','profile_text','website'));

-- Identical to the applied definition except that 'website' joins the
-- handed-over types. queued_at is required for the same reason it is for
-- documents: the inline path may still be working on the row, and a crawl is
-- only claimable once its Firecrawl job id has been recorded.
CREATE OR REPLACE FUNCTION public.claim_ai_knowledge_excel_source()
RETURNS SETOF public.ai_knowledge_sources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed public.ai_knowledge_sources;
BEGIN
  WITH candidate AS (
    SELECT id
    FROM public.ai_knowledge_sources
    WHERE (
        status = 'pending'
        OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
      )
      AND (
        source_type IN ('excel', 'csv')
        OR (source_type IN ('doc', 'pdf', 'image', 'website') AND queued_at IS NOT NULL)
      )
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.ai_knowledge_sources source
  SET status = 'processing', error = NULL
  FROM candidate
  WHERE source.id = candidate.id
  RETURNING source.* INTO claimed;

  IF FOUND THEN RETURN NEXT claimed; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_knowledge_excel_source() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ai_knowledge_excel_source() TO service_role;

-- The drainer. Same shape as the other function-invoking crons in this
-- database; the secret comes from the same vault entry they use.
SELECT cron.schedule(
  'drain-ai-knowledge-queue',
  '*/2 * * * *',
  $cron$
  SELECT net.http_post(
    url := current_setting('app.functions_url', true) || '/ai-knowledge-excel-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  );
  $cron$
);
```

**Before writing this step's SQL for real, read an existing cron definition** — `SELECT jobname, command FROM cron.job WHERE jobname = 'process-pending-agent-replies';` — and copy its exact URL and secret mechanism. The placeholders above (`app.functions_url`, `app.cron_secret`) must be replaced with whatever that job actually uses. A cron that 401s looks identical to a cron that never ran.

- [ ] **Step 2: Read the reference cron and correct the SQL**

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db \
  psql -U supabase_admin -d postgres -c \
  "SELECT command FROM cron.job WHERE jobname='process-pending-agent-replies';"
```

Rewrite the `cron.schedule` block to match.

- [ ] **Step 3: Rehearse on the PG17 harness**

Apply the migration, then prove the predicate:

```sql
INSERT INTO public.ai_knowledge_sources (user_id, source_type, file_name, status)
VALUES ('<harness user>', 'website', 'x', 'pending');
SELECT count(*) FROM public.claim_ai_knowledge_excel_source();  -- expect 0: queued_at is NULL

UPDATE public.ai_knowledge_sources SET queued_at = now() WHERE source_type='website';
SELECT count(*) FROM public.claim_ai_knowledge_excel_source();  -- expect 1
```

The cron block is skipped on the harness if `pg_cron` is absent — note that and verify the cron on production instead.

- [ ] **Step 4: Apply to production and reload PostgREST**

```bash
docker cp <local>/20260905110000_knowledge_website_sources.sql \
  postorasupabase-supabase-j8axyh-supabase-db:/tmp/m2.sql
docker exec postorasupabase-supabase-j8axyh-supabase-db \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/m2.sql
docker exec postorasupabase-supabase-j8axyh-supabase-db \
  psql -U supabase_admin -d postgres -c "NOTIFY pgrst, 'reload schema';"
```

- [ ] **Step 5: Verify the cron actually fires**

Wait one interval, then:

```sql
SELECT status, return_message, start_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='drain-ai-knowledge-queue')
ORDER BY start_time DESC LIMIT 3;
```

Expected: `succeeded`. A 401 in `return_message` means the secret is wrong — fix it before moving on, or every crawl will hang.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(db): website knowledge sources and the queue drain cron" -- supabase/migrations/20260905110000_knowledge_website_sources.sql
```

---

### Task 14: The `ingest_website` action

**Files:**
- Modify: `supabase/functions/ai-knowledge-ingest/index.ts`
- Test: `supabase/functions/ai-knowledge-ingest/website.test.ts`

**Interfaces:**
- Consumes: `validateKnowledgeUrl` (Task 11), the Firecrawl client (Task 12), Migration B (Task 13).
- Produces: action `ingest_website` with body `{ url: string, mode: "page" | "site", limit?: number, social_account_id?: string, scope?: "account" | "all" }`. Produces `buildWebsiteSourceName(url: string, mode: "page" | "site"): string`, exported for the test.

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildWebsiteSourceName } from "./index.ts";

Deno.test("a page source is named by its path", () => {
  assertEquals(buildWebsiteSourceName("https://xsellpoint.com/shop/shoes", "page"), "xsellpoint.com/shop/shoes");
});

Deno.test("a site source is named by its host", () => {
  assertEquals(buildWebsiteSourceName("https://xsellpoint.com/shop", "site"), "xsellpoint.com (whole site)");
});

Deno.test("a long path is truncated so the name stays readable", () => {
  const name = buildWebsiteSourceName(`https://x.com/${"a".repeat(300)}`, "page");
  assertEquals(name.length <= 120, true);
});
```

`index.ts` already serves on import, so guard the `Deno.serve` call with `if (import.meta.main)` as `ai-knowledge-excel-worker` does — otherwise importing it from a test starts a server.

- [ ] **Step 2: Run and watch it fail**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/ai-knowledge-ingest/website.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `buildWebsiteSourceName` and the action**

Add the helper (exported), then the action beside `ingest_source`:

```ts
if (action === "ingest_website") {
  const check = validateKnowledgeUrl(body.url);
  if (!check.ok) return errorResponse(check.reason, 400);
  const mode = body.mode === "site" ? "site" : "page";
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);

  let key: string;
  try {
    key = await resolveFirecrawlKey(admin);
  } catch (error) {
    // A 400, never a 5xx: Cloudflare replaces an origin 5xx body with its own
    // page, and the user would see "something went wrong" instead of the
    // sentence naming the admin setting they need.
    return errorResponse(message(error), 400);
  }

  const scopeToAccount = body.scope === "account" && typeof body.social_account_id === "string";
  const { data: sourceId, error: createError } = await (admin as any).rpc("create_ai_knowledge_source", {
    p_source_type: "website",
    p_file_name: buildWebsiteSourceName(check.url, mode),
    p_file_path: check.url,
    p_social_account_ids: scopeToAccount ? [body.social_account_id] : [],
    p_visibility: scopeToAccount ? "restricted" : "shared",
  });
  if (createError) throw createError;

  const setMeta = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    (admin as any)
      .from("ai_knowledge_sources")
      .update({ metadata: { url: check.url, mode, ...patch }, ...extra })
      .eq("id", sourceId);

  if (mode === "site") {
    try {
      const jobId = await firecrawlStartCrawl(key, check.url, limit);
      await setMeta(
        { crawl_job_id: jobId, stage: "crawling", pages_done: 0, pages_total: limit },
        { status: "pending", chunk_count: 0, error: null, queued_at: new Date().toISOString() },
      );
      await logKnowledgeEvent(admin, user.id, "ingest_website", true, { source_id: sourceId, mode, url: check.url, crawl_job_id: jobId });
      return jsonResponse({ ok: true, queued: true, source_id: sourceId }, 202);
    } catch (error) {
      await setFailed(admin, sourceId, error);
      await logKnowledgeEvent(admin, user.id, "ingest_website", false, { source_id: sourceId, mode, error: message(error).slice(0, 500) });
      return errorResponse(message(error), 400);
    }
  }

  try {
    await setMeta({ stage: "crawling" }, { status: "processing", error: null });
    const page = await firecrawlScrape(key, check.url);
    await setMeta({ stage: "embedding", pages_done: 1, pages_total: 1 });
    const chunks = chunkProfileText(`${page.title}\n\n${page.markdown}`);
    if (chunks.length > MAX_INLINE_CHUNKS) {
      // Same handoff the document path makes: parsing is cheap, embedding is
      // what runs out of the 60s budget.
      await setMeta(
        { stage: "embedding", pages_done: 1, pages_total: 1, scraped_markdown: page.markdown },
        { status: "pending", chunk_count: 0, error: null, queued_at: new Date().toISOString() },
      );
      return jsonResponse({ ok: true, queued: true, chunks: chunks.length }, 202);
    }
    const stored = await replaceChunks(admin, sourceId, user.id, chunks);
    await (admin as any)
      .from("ai_knowledge_sources")
      .update({ status: "ready", chunk_count: chunks.length, error: null })
      .eq("id", sourceId);
    await updateKnowledgeGraph(admin, user.id, stored);
    await logKnowledgeEvent(admin, user.id, "ingest_website", true, { source_id: sourceId, mode, url: check.url, chunk_count: chunks.length });
    return jsonResponse({ ok: true, chunk_count: chunks.length });
  } catch (error) {
    await setFailed(admin, sourceId, error);
    await logKnowledgeEvent(admin, user.id, "ingest_website", false, { source_id: sourceId, mode, error: message(error).slice(0, 500) });
    return errorResponse(message(error), 400);
  }
}
```

Also allow `website` in `delete_source`'s handling (it takes no storage object — `deleteSourceFile` must skip a `file_path` that is an `https:` URL rather than trying to locate a storage object; check `locateKnowledgeFile` returns null for it, and if it does not, add the guard).

- [ ] **Step 4: Run the tests and type check**

```bash
deno test --no-check --node-modules-dir=none supabase/functions/ai-knowledge-ingest/
deno check supabase/functions/ai-knowledge-ingest/index.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(knowledge): ingest a page or a whole site through Firecrawl" -- supabase/functions/ai-knowledge-ingest/index.ts supabase/functions/ai-knowledge-ingest/website.test.ts
```

---

### Task 15: The worker polls crawls

**Files:**
- Modify: `supabase/functions/ai-knowledge-excel-worker/index.ts`
- Test: `supabase/functions/ai-knowledge-excel-worker/website.test.ts`

**Interfaces:**
- Consumes: the Firecrawl client (Task 12), Migration B (Task 13).
- Produces: `processWebsiteSource(admin, source, deps): Promise<SourceOutcome>`, dispatched from `processSource` when `source.source_type === "website"`.

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("a crawl still running is released, not failed", async () => {
  // The claim marked it 'processing'. Returning it to 'pending' is what lets
  // the next tick pick it up; leaving it 'processing' means only the 10-minute
  // stale reclaim ever touches it again.
  const updates: Record<string, unknown>[] = [];
  const admin = fakeAdmin(updates);
  const outcome = await processWebsiteSource(
    admin,
    { id: "s1", user_id: "u1", source_type: "website", metadata: { crawl_job_id: "j", url: "https://x.com" } },
    { ...deps, crawlStatus: () => Promise.resolve({ state: "running", completed: 2, total: 9, pages: [] }) },
  );
  assertEquals(outcome.status, "pending");
  assertEquals(updates.at(-1)?.status, "pending");
  assertEquals((updates.at(-1)?.metadata as any).pages_done, 2);
});

Deno.test("a completed crawl embeds every page and goes ready", async () => {
  const updates: Record<string, unknown>[] = [];
  const admin = fakeAdmin(updates);
  const outcome = await processWebsiteSource(
    admin,
    { id: "s1", user_id: "u1", source_type: "website", metadata: { crawl_job_id: "j", url: "https://x.com" } },
    {
      ...deps,
      crawlStatus: () =>
        Promise.resolve({
          state: "completed",
          completed: 2,
          total: 2,
          pages: [
            { url: "https://x.com/a", title: "A", markdown: "alpha" },
            { url: "https://x.com/b", title: "B", markdown: "beta" },
          ],
        }),
    },
  );
  assertEquals(outcome.status, "ready");
  assertEquals(updates.at(-1)?.status, "ready");
});

Deno.test("a failed crawl records the provider's reason", async () => {
  const updates: Record<string, unknown>[] = [];
  const admin = fakeAdmin(updates);
  const outcome = await processWebsiteSource(
    admin,
    { id: "s1", user_id: "u1", source_type: "website", metadata: { crawl_job_id: "j" } },
    { ...deps, crawlStatus: () => Promise.resolve({ state: "failed", completed: 0, total: 0, pages: [], error: "robots" }) },
  );
  assertEquals(outcome.status, "failed");
  assertEquals(updates.at(-1)?.error, "robots");
});

Deno.test("a crawl older than 30 minutes fails rather than polling forever", async () => {
  const updates: Record<string, unknown>[] = [];
  const admin = fakeAdmin(updates);
  const outcome = await processWebsiteSource(
    admin,
    {
      id: "s1", user_id: "u1", source_type: "website",
      created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      metadata: { crawl_job_id: "j" },
    },
    { ...deps, crawlStatus: () => Promise.resolve({ state: "running", completed: 1, total: 9, pages: [] }) },
  );
  assertEquals(outcome.status, "failed");
});

Deno.test("a website source with no crawl job id fails immediately", async () => {
  const updates: Record<string, unknown>[] = [];
  const admin = fakeAdmin(updates);
  const outcome = await processWebsiteSource(admin, { id: "s1", user_id: "u1", source_type: "website", metadata: {} }, deps);
  assertEquals(outcome.status, "failed");
});
```

`fakeAdmin` records every `.update()` payload; model it on the fake query builder already used in the partner-api tests.

- [ ] **Step 2: Run and watch it fail**

```bash
deno test --no-check --node-modules-dir=none --node-modules-dir=none supabase/functions/ai-knowledge-excel-worker/website.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement it**

Add `crawlStatus` and `scrapeKey` to `WorkerDependencies` so the test can inject them. In `processSource`, dispatch on `source.source_type === "website"` to `processWebsiteSource` before the existing spreadsheet path. `processWebsiteSource`:

1. `metadata.crawl_job_id` missing → `status='failed'`, error `"Crawl job id is missing"`.
2. `created_at` older than 30 minutes → `status='failed'`, error `"Crawl timed out"`; keep `metadata` so support can look the job up.
3. `crawlStatus` `running` → update `metadata.pages_done/pages_total`, `stage='crawling'`, set `status='pending'` (releasing the claim) and return `{ status: "pending" }`.
4. `failed` → `status='failed'` with the provider's error truncated to 500.
5. `completed` → `stage='embedding'`, chunk each page as `chunkProfileText(`${page.title}\n${page.url}\n\n${page.markdown}`)`, embed through the same `embed`/`resolveConfig` path the spreadsheet branch uses with the same `CHECKPOINT_BATCH` checkpointing, then `status='ready'` with the total chunk count.

Reuse the existing embedding and checkpoint helpers rather than writing new ones — the resumability is the point of them.

- [ ] **Step 4: Run and type check**

```bash
deno test --no-check --node-modules-dir=none --node-modules-dir=none supabase/functions/ai-knowledge-excel-worker/
deno check --node-modules-dir=none supabase/functions/ai-knowledge-excel-worker/index.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(knowledge): the queue worker finishes website crawls" -- supabase/functions/ai-knowledge-excel-worker/index.ts supabase/functions/ai-knowledge-excel-worker/website.test.ts
```

---

### Task 16: The Website panel

**Files:**
- Modify: `src/components/messaging/knowledge/WebsitePanel.tsx`
- Modify: `src/components/messaging/knowledge/KnowledgeSourcesPanel.tsx`
- Modify: `src/components/messaging/AiKnowledgeManager.tsx`
- Modify: `src/lib/aiKnowledge.ts`
- Modify: `src/hooks/useAiKnowledge.ts`
- Test: `src/components/messaging/__tests__/WebsitePanel.test.tsx`

**Interfaces:**
- Consumes: the `ingest_website` action (Task 14).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```tsx
it("refuses a non-https URL before calling the server", () => {
  const onSubmit = vi.fn();
  render(<WebsitePanel onSubmit={onSubmit} submitting={false} accountId="a1" selectedAccountLabel="Shop" />);
  fireEvent.change(screen.getByLabelText(/website address/i), { target: { value: "http://x.com" } });
  fireEvent.click(screen.getByRole("button", { name: /start scraping/i }));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByText(/must start with https/i)).toBeInTheDocument();
});

it("submits the url, the mode and the page cap", () => {
  const onSubmit = vi.fn();
  render(<WebsitePanel onSubmit={onSubmit} submitting={false} accountId="a1" selectedAccountLabel="Shop" />);
  fireEvent.change(screen.getByLabelText(/website address/i), { target: { value: "https://x.com" } });
  fireEvent.click(screen.getByRole("radio", { name: /whole site/i }));
  fireEvent.click(screen.getByRole("button", { name: /start scraping/i }));
  expect(onSubmit).toHaveBeenCalledWith({ url: "https://x.com", mode: "site", limit: 50, scope: "account" });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
bun run test -- src/components/messaging/__tests__/WebsitePanel.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Build the panel**

`WebsitePanelProps`:

```ts
export interface WebsitePanelProps {
  accountId: string | null;
  selectedAccountLabel: string | null;
  submitting: boolean;
  onSubmit: (input: { url: string; mode: "page" | "site"; limit: number; scope: "account" | "all" }) => void;
}
```

Controls: a URL `Input` labelled `Website address`; a radio group `This page only` / `Whole site`; a page-cap `Input type="number"` (default 50, min 1, max 200) shown only in site mode, with the note `Each page is scraped and embedded — a large site costs credits and takes a few minutes.`; the same `Available to` scope select the Upload panel uses; and a `Start scraping & indexing` button.

Client-side validation mirrors the server's first two rules so the user gets an instant answer: non-empty, and starts with `https://`. Everything else is the server's job — never duplicate the private-host list in two places that can drift.

- [ ] **Step 4: Wire it into `AiKnowledgeManager`**

```tsx
<WebsitePanel
  accountId={accountId}
  selectedAccountLabel={selectedAccountLabel}
  submitting={invoke.isPending}
  onSubmit={(input) =>
    run(
      "ingest_website",
      { ...input, social_account_id: accountId ?? undefined },
      input.mode === "site" ? "Crawl started — watch the sources list below" : "Page indexed",
    )
  }
/>
```

- [ ] **Step 5: Show the crawl stage in the sources list**

Add `metadata` to `AiKnowledgeSource` in `useAiKnowledge.ts` (the query already selects `*`). In `KnowledgeSourcesPanel`, when `source.source_type === "website"` and the status is `pending` or `processing`, render a small checklist under the badges from `metadata.stage`:

```tsx
const STAGES = [
  { key: "crawling",   label: "Reading pages" },
  { key: "extracting", label: "Extracting text" },
  { key: "embedding",  label: "Indexing into the vector database" },
] as const;
```

Each row shows a `CheckCircle2` when passed, a spinner on the current stage, and a muted dot ahead of it, plus `pages_done / pages_total` when both are present. The existing 5s `refetchInterval` while a source is pending/processing is what animates it — no new transport.

Add `website: "website"` handling to `src/lib/aiKnowledge.ts` so the source-type badge reads `website` rather than falling through.

- [ ] **Step 6: Run everything**

```bash
bun run test && bunx tsc --noEmit
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(knowledge): website scraping panel with a live crawl checklist" -- src/components/messaging/knowledge src/components/messaging/AiKnowledgeManager.tsx src/lib/aiKnowledge.ts src/hooks/useAiKnowledge.ts src/components/messaging/__tests__/WebsitePanel.test.tsx
```

- [ ] **Step 8: Deploy and verify end to end**

Same order as slice 3: migration first (Task 13, already applied), then **merge**
and let `deploy-edge-functions.yml` ship it — that workflow already knows to
restart `ai-knowledge-excel-worker` when `_shared/` or the worker changes. Fall
back to the manual runbook from `origin/main` only if Actions is billing-blocked.

Then, in the app: scrape one page of a real site and confirm the source reaches `ready` with a chunk count; start a whole-site crawl and confirm it moves `crawling → embedding → ready` across cron ticks. Check `system_logs` for the `ingest_website` rows.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §5.3 Knowledge sub-tabs + pinned sources | 1, 2 |
| §5.3 Settings cards | 3, 10 |
| §5.1 Migration A + structured profile | 4, 6, 7, 9 |
| §5.1 `agent_behavior` | 5, 6, 7, 10 |
| §5.2 Prompt wiring + handoff flags | 8 |
| §5.1 Migration B (`metadata`, `website`, queue predicate) | 13 |
| §5.4 Firecrawl scrape/crawl + SSRF validation | 11, 12, 14 |
| §5.4 Crawl polling worker + the missing cron | 13, 15 |
| §5.4 Live stage checklist | 16 |
| §6 Error handling (400 not 5xx, 30-minute timeout, `confirm_clear`) | 12, 14, 15, 7, 9 |
| §7 Testing | every task |
| §3 Non-goals (DOCX, embedding pipeline, tenancy) | not implemented, by design |

**Naming consistency check:** `renderBusinessProfileText` / `parseBusinessProfile` / `parseAgentBehavior` / `behaviorRules` / `validateKnowledgeUrl` / `firecrawlScrape` / `firecrawlStartCrawl` / `firecrawlCrawlStatus` / `resolveFirecrawlKey` / `buildWebsiteSourceName` / `processWebsiteSource` are each defined once and referenced with the same spelling everywhere. `AgentCardProps` is defined in Task 3 and reused in Task 10. `business_profile` / `agent_behavior` are spelled identically in the migration, the allow-list, `CONFIG_FIELDS` and the components.

**Known open item for the executor:** Task 13 Step 2 requires reading the real cron definition before finalising the SQL. That is a deliberate lookup, not a placeholder — the exact URL and secret mechanism are database state, not repository state.
