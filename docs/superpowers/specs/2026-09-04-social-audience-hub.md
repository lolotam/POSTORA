# Design Specification: Social Audience Hub & Lead CRM

**Date**: 2026-09-04  
**Status**: Draft / Under Review  
**Feature**: Social Audience Hub & Commenter Lead Capture (Social CRM)  
**Target Path**: `/automation/audience`  

---

## 1. Executive Summary & Core Concept

Postora manages multi-platform social scheduling, manual comment moderation, and automated comment-to-DM workflows. However, every time an audience member comments on a post, their engagement currently terminates as an isolated event in `social_inbox_events` or `comment_workflow_events`.

The **Social Audience Hub** transforms these ephemeral social interactions across **Facebook, Instagram, YouTube, Threads, and WhatsApp** into a persistent, searchable, and exportable **Social CRM (Customer Relationship Management)** database.

### The Value Proposition
1. **Zero-Effort Lead Generation**: Automatically captures and catalogues every engaged user without requiring manual data entry.
2. **High-Intent Segmentation**: Automatically tags and distinguishes casual commenters (`Organic Commenter`) from high-intent buyers (`Workflow Lead: Offer Campaign`).
3. **Omnichannel Retargeting**:
   - **Meta Custom Audiences (CSV)**: Export formatted lists directly into Facebook Ads Manager for Lookalike and Custom Audience creation.
   - **Google Sheets Live Sync**: Push new leads directly into spreadsheets using Postora's verified Composio Google Sheets connector.
   - **WhatsApp Re-engagement**: One-click direct conversation initiation via Postora's WhatsApp Cloud API for contacts with captured phone numbers.

---

## 2. Information Architecture & Navigation

### 2.1 Navigation Placement
To preserve clean top-level navigation while clustering all automation and lead-generation assets together, the Audience Hub lives under the **Automation** menu in `DashboardLayout.tsx`:

- **Overview**: `/automation`
- **Agent Setup**: `/automation/agents`
- **Comment Workflows**: `/automation/comment-workflow`
- **Audience & Contacts**: `/automation/audience` **[NEW]**

### 2.2 Page Structure (`AudiencePage.tsx`)
The page provides a single, high-density, performant dashboard:

1. **Header & Quick Actions**:
   - Title: "Audience & Contacts" / "مركز الجمهور والعملاء"
   - Real-time indicator of total captured contacts.
   - **Export Button**: Dropdown with `Export Meta Ads CSV` and `Export Full CSV`.
   - **Sync to Google Sheets Button**: Configuration modal to map contacts to a selected Composio Google Sheet.

2. **Metrics & KPI Bar**:
   - **Total Contacts**: Total unique social identities captured.
   - **Qualified Leads**: Count of users who triggered an automated Comment Workflow.
   - **Enriched Contacts**: Users with captured phone numbers or emails.
   - **Top Platform**: Platform generating the highest volume of engagements.

3. **Smart Filters & Search Bar**:
   - Search input: Query by display name, username, phone number, or email.
   - Platform Filter: `[ All Platforms | Instagram | Facebook | YouTube | WhatsApp ]`.
   - Source Filter: `[ All Sources | Organic Comments | Workflow Leads | WhatsApp Chats ]`.
   - Tag Filter: Multiselect dropdown for tags (e.g., `#lead`, `#pricing`, `#superfan`).

4. **Contacts Data Table**:
   - **Contact**: Avatar + Display Name + Platform icon + Handle/Profile URL.
   - **Source**: Badge showing `Organic` or triggering Workflow rule name (e.g. `Workflow: Promo2026`).
   - **Direct Contact Info**: Phone number and Email (with "Copy" button or "Not Captured" indicator).
   - **Engagement Volume**: Total comments/messages count + `Last Active` relative timestamp.
   - **Tags**: Dynamic badge pills with inline "+ Add Tag" popover.
   - **Actions**:
     - *Chat on WhatsApp*: Appears when a phone number is present; opens the chat directly in Postora Messaging (`/messaging?platform=whatsapp&phone=...`).
     - *View Profile / History*: Opens a side-drawer showing all comments, posts interacted with, and metadata.
     - *Delete / Merge*: Options to manage individual records.

5. **Contact Details Drawer (`ContactDetailsDrawer.tsx`)**:
   - Complete interaction timeline: Date, post title/link, comment content, and workflow reply delivered.
   - Editable fields: Full Name, Email, Phone, Company, Custom Notes.
   - Merge Tool: Allows manually linking another social identity to this contact.

---

## 3. Data Model & Database Architecture

### 3.1 New Table: `public.social_contacts`
The primary table storing captured social profiles and leads.

```sql
CREATE TABLE public.social_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  social_account_id uuid REFERENCES public.social_accounts(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('facebook', 'instagram', 'youtube', 'threads', 'whatsapp')),
  platform_user_id text NOT NULL, -- Page-Scoped ID, IG Scoped ID, YouTube Channel ID, or WhatsApp Phone
  
  -- Public Profile Information
  display_name text NOT NULL DEFAULT '',
  username text,
  avatar_url text,
  profile_url text,
  
  -- Captured First-Party Contact Data
  email text,
  phone_number text,
  
  -- Lead Tracking & Attribution
  source text NOT NULL DEFAULT 'organic_comment' CHECK (source IN ('organic_comment', 'workflow_lead', 'direct_message')),
  workflow_rule_id uuid REFERENCES public.comment_workflow_rules(id) ON DELETE SET NULL,
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  
  -- Engagement Metrics
  total_comments_count integer NOT NULL DEFAULT 1,
  total_messages_count integer NOT NULL DEFAULT 0,
  first_interacted_at timestamptz NOT NULL DEFAULT now(),
  last_interacted_at timestamptz NOT NULL DEFAULT now(),
  
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Uniqueness per user workspace and platform identity
  CONSTRAINT social_contacts_user_platform_identity_key UNIQUE (user_id, platform, platform_user_id)
);
```

### 3.2 Performance Indexes
```sql
CREATE INDEX social_contacts_user_idx ON public.social_contacts(user_id);
CREATE INDEX social_contacts_user_platform_idx ON public.social_contacts(user_id, platform);
CREATE INDEX social_contacts_user_last_active_idx ON public.social_contacts(user_id, last_interacted_at DESC);
CREATE INDEX social_contacts_tags_gin_idx ON public.social_contacts USING GIN (tags);
CREATE INDEX social_contacts_phone_idx ON public.social_contacts(user_id, phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX social_contacts_email_idx ON public.social_contacts(user_id, email) WHERE email IS NOT NULL;
```

### 3.3 Multi-Tenant Row Level Security (RLS)
Strict tenant isolation in accordance with `ARCHITECTURE.md`:
```sql
ALTER TABLE public.social_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own social contacts"
  ON public.social_contacts
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
```

---

## 4. Ingestion Engine & Automated Enrichment

### 4.1 Automated Ingestion Pipeline
Contacts are created or updated opportunistically without blocking webhook responses:

1. **When a Comment Arrives** (Meta Webhook / YouTube 5-minute Poller / Threads Poller):
   - Check if a contact exists for `(user_id, platform, platform_user_id)`.
   - **If New**: Insert row with `total_comments_count = 1`, `source = 'organic_comment'`, `display_name`, `avatar_url`, and `metadata.last_comment`.
   - **If Existing**: Increment `total_comments_count`, update `last_interacted_at = now()`, and refresh name/avatar if provided.

2. **When a Comment Workflow Triggers** (`comment_workflow_events`):
   - Upgrade the contact row:
     - Set `source = 'workflow_lead'` (if previously organic).
     - Link `workflow_rule_id`.
     - Append automated tags (e.g., `tags = array_append(tags, 'workflow_lead')` and the specific rule keyword tag).

3. **When an Inbound Message Contains Contact Info**:
   - If the user responds in a DM with an email or phone number during an AI or workflow funnel, the lead extractor parses the phone/email regex and enriches the existing contact row.

### 4.2 Progressive Identity & Merging
- If a contact is created with an Instagram ID and later provides a phone number matching an existing WhatsApp contact under the same `user_id`, the system suggests or auto-links them:
  - `metadata.linked_platforms = ['instagram', 'whatsapp']`
  - Consolidates total interaction history into one unified timeline.

---

## 5. Omnichannel Retargeting Integrations

### 5.1 Meta Custom Audiences Export (CSV)
Postora generates a downloadable CSV formatted to Meta's exact Ads Manager specifications:
- Headers: `email`, `phone`, `fn` (First Name), `ln` (Last Name), `platform_id`
- Data is normalized (E.164 phone format, lowercased emails) to maximize Meta's match rate for Lookalike and Custom Audience creation.

### 5.2 Google Sheets Sync (via Composio Connector)
Leveraging Postora's live Composio connector framework:
- Users select an existing connected Google Sheets account (`COMPOSIO_AUTH_CONFIG_GOOGLE_SHEETS`).
- When a new lead is captured or tagged with a target tag (e.g., `lead`), the system calls `executeTool` with `GOOGLESHEETS_APPEND_ROW`.
- Columns synced: `Date`, `Name`, `Platform`, `Handle`, `Phone`, `Email`, `Source`, `Triggering Comment`.

### 5.3 Direct WhatsApp Cloud Messaging
- For contacts with a validated phone number, a "Chat on WhatsApp" action directs the user to Postora's native WhatsApp Chat screen (`/messaging?platform=whatsapp`), pre-filling the conversation window.

---

## 6. Security, Compliance & Platform Guidelines

1. **Meta 24-Hour Messaging Window Compliance**:
   - The Audience Hub is an analytical and contact database. It does **not** bypass Meta's 24-hour rule.
   - Outbound private messages remain subject to Meta's message tags and window constraints.
2. **YouTube Terms of Service**:
   - YouTube contacts store public channel info (`authorChannelId`, `authorDisplayName`, `authorProfileImageUrl`).
   - No direct messaging is attempted on YouTube; export and public interaction tracking only.
3. **Data Protection & Privacy**:
   - Users can delete individual contacts or bulk-purge their audience database at any time (GDPR / right-to-be-forgotten compliant).
   - Deleting a connected social account sets `social_account_id = NULL` on contacts, preserving the user's historical customer list.

---

## 7. Feature Flag & Phased Implementation

### 7.1 Feature Flag
- Flag Key: `feature_audience_hub`
- Default: `false` (Visible to Admins immediately).
- Plumbed through `src/hooks/useFeatureFlags.ts`.

### 7.2 Implementation Phases
- **Phase 1: Database & Background Ingest**
  - Migration creating `social_contacts` table, RLS, and indexes.
  - Integration into `social_inbox_events` and `comment_workflow` execution.
- **Phase 2: UI Dashboard & Contacts Table**
  - Navigation tab under `/automation/audience`.
  - Filter bar, search, KPI stats, and contacts table with tag management.
- **Phase 3: Export & Integrations**
  - CSV export for Meta Ads.
  - Composio Google Sheets live push.
  - WhatsApp quick-action integration.
