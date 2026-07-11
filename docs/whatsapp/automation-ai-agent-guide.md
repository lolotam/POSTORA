# WhatsApp Automation & AI-Agent Guide

Customer-facing knowledge base for the WhatsApp mini-app at `/messaging/whatsapp`.
Explains the six automation surfaces, how to combine them, and how to layer an
AI agent on top of Postora's existing webhooks.

The detailed technical setup (Meta App Dashboard, edge-function secrets, SQL
flags) lives in [`setup-guide.md`](./setup-guide.md). This guide focuses on
product behaviour, day-to-day usage, and automation design.

---

## 1. The six automation surfaces at a glance

| Surface | Who sends the reply | Trigger | Output channel | Best for |
|---|---|---|---|---|
| **Quick Replies** | A human agent | Agent picks a shortcut in the inbox | WhatsApp text | Repeated manual answers (delivery time, pricing, thank-you) |
| **Auto Replies** | Postora rule engine | Inbound message matches keyword or falls in away-hours window | WhatsApp text | Instant acknowledgements, FAQs, after-hours reply |
| **Broadcasts** | Postora campaign | Manual "Send" on a saved campaign | WhatsApp template message | Opted-in announcements, promotions, restock alerts |
| **Agents** | A human teammate | Inbound arrives in the team inbox; routed to a registered agent | WhatsApp text | Sales/support/escalation routing with concurrent caps |
| **Templates** | Postora or human | Manual send, broadcast, scheduled, or after handoff | WhatsApp template message | Anything outside the 24-hour customer-service window |
| **Webhooks** | External system | Inbound message arrives in `whatsapp-webhook` | HTTP POST to your URL | CRM sync, n8n flows, AI agent, ERP updates, alerting |

### Important distinctions

- **Quick Reply vs. Auto Reply** — a Quick Reply is a button a human clicks; an
  Auto Reply fires automatically on keyword or schedule.
- **Agent vs. AI Agent** — Postora's current Agents tab registers *human*
  teammates. There is no AI knowledge agent in Postora yet; today, AI is
  reached through a Webhook → n8n (or your backend) → reply loop.
- **Template vs. Free-form text** — once a conversation is older than 24 hours
  since the customer's last message, Meta blocks free-form replies and
  requires an approved template.
- **Broadcast vs. Template** — broadcasts are template messages sent to many
  opted-in contacts; templates are the message format that broadcasts and
  re-engagements use.

---

## 2. Current implementation notes (verified against code)

These details are sourced from the existing migrations and edge functions, so
the guide matches real behaviour rather than intent.

- **Auto Replies** are stored in `whatsapp_auto_replies` (see
  `supabase/migrations/20260413214314_dc16debe-abef-4aa1-9191-2acdfdc17d15.sql`).
  Rule types: `away` and `keyword`. A five-minute per-conversation cooldown is
  enforced inside `processAutoReplies()` in
  `supabase/functions/whatsapp-webhook/index.ts`.
- **Quick Replies** live in `whatsapp_quick_replies` and are surfaced in the
  inbox via the `QuickReplyPicker` and logged in
  `whatsapp_quick_reply_usage` for the response-stats dashboard.
- **Broadcasts** are persisted in `whatsapp_broadcasts` and
  `whatsapp_broadcast_recipients`; the `whatsapp-broadcast` edge function sends
  them with 100 ms throttling and a hard cap of 1000 recipients per
  invocation.
- **Templates** must be **APPROVED** before a broadcast can pick them; the
  UI filters to `status = 'APPROVED'` in `BroadcastManager.tsx`.
- **Agents** are stored in `whatsapp_agents` and conversation ownership in
  `whatsapp_conversation_assignments` (with active-assignment unique index
  and `whatsapp_assignment_history` for audit). See
  `20260413234250_b395c5e3-36eb-4c94-b994-ed9c4684587b.sql`.
- **Webhooks** use `whatsapp_webhooks` (`events TEXT[]`,
  `failure_count`); the dispatcher signs payloads with HMAC-SHA256 when a
  `secret` is set and auto-disables a webhook after 10 consecutive failures.

---

## 3. Recommended setup order (user journey)

1. **Connect the number** in `/messaging/whatsapp/setup` using Embedded
   Signup (cloud API or coexistence). Confirm inbound messages appear in
   `/messaging/whatsapp/conversations`.
2. **Complete the business profile** in the Profile tab.
3. **Import contacts and groups** in the Contacts tab (CSV upload or manual
   entry). Tag VIPs, leads, and existing customers.
4. **Create Meta-approved Templates** in the Templates tab. Meta review
   typically takes 2–24 hours. Submit the templates you will need for
   broadcasts, scheduled re-engagements, and order updates *first*, because
   they block downstream automations.
5. **Add Quick Replies** for the 10–20 most common manual answers. Keep
   them short, on-brand, and parameterized where possible
   (e.g. `Hi {name}, your order is on the way — track it here: {url}`).
6. **Add Auto Replies** for deterministic cases:
   - Away-hours acknowledgement (rule type `away`, schedule window + days).
   - Top-five keyword FAQs (rule type `keyword`): "price", "address",
     "delivery", "booking", "hours".
7. **Register human agents** in the Agents tab. Each agent picks
   online / away / offline; `max_conversations` is enforced.
8. **Configure a Webhook** to your automation platform (n8n, Make, Zapier,
   custom backend). The webhook fires for every inbound message, so it
   becomes the integration point for AI agents, CRMs, and analytics.
9. **Send a small Broadcast** as a smoke test (10–20 contacts) using an
   approved template. Review the BroadcastStatus for delivery and
   read-receipt behaviour.
10. **Review Analytics and Response Stats weekly** to tune Quick Replies,
    detect under-staffing on Agents, and prune unused Templates.

---

## 4. Practical use cases per section

| Business need | Recommended surfaces |
|---|---|
| Customer asks for opening hours | Auto Reply (keyword) + Quick Reply |
| Complex product question | Webhook → n8n/AI agent → reply → Agent handoff if needed |
| New lead arrives | Webhook → CRM deal + notify salesperson (Agent tab) |
| Promote a discount | Template + Broadcast |
| Appointment reminder | Template + Scheduled (or n8n trigger) |
| Order status enquiry | Webhook → ERP/Shopify lookup → reply with approved template data |
| Complaint or refund request | Keyword rule to acknowledge + Webhook to Agent handoff |
| After-hours chat | Auto Reply (away) + Webhook to async AI follow-up next morning |
| Re-engagement after 24h | Template + Broadcast (requires opt-in) |
| Internal KPI reporting | Webhook → n8n → Sheets / warehouse |

---

## 5. Adding an AI agent layer

The AI agent is **not** a replacement for the six sections — it is a layer
that sits between the Webhook and the Agents tab, with a clear handoff
contract.

```
Customer message
  -> whatsApp-webhook (ingest, persist to messaging_cache)
  -> Auto Reply rules (deterministic, low-risk)
  -> Webhook event "message.received"  ──>  n8n / your backend
                                            │
                                            ├── Identify customer
                                            ├── Retrieve business data
                                            │   (catalog, FAQs, orders)
                                            ├── AI generates reply
                                            ├── Decision:
                                            │     high confidence → send
                                            │     low confidence  → Agent
                                            │     unsafe topic     → Agent
                                            └── Log decision + payload
  -> Agent handoff (with AI summary)
```

### How the layer coexists with existing surfaces

- **Auto Replies** still own deterministic responses (hours, fixed pricing,
  acknowledgements). The AI agent only sees messages that Auto Replies
  did *not* fire on.
- **Quick Replies** still apply after a human takes over; the AI can
  pre-populate a suggested reply and the agent clicks to send.
- **Templates** still gate business-initiated messages outside the 24-hour
  window. The AI agent may *suggest* a template by name; the send still
  goes through Postora so the template is approved and billed correctly.
- **Agents** still own handoff. The AI flags the conversation with a
  `summary` and `suggested_reply`; the human agent sees this in the inbox.
- **Broadcasts** remain a manual campaign tool. AI does not auto-broadcast.
- **Webhooks** are the integration point. The new agent flow is just
  another consumer of `event = "message.received"`.

### Business data sources

| Data | Recommended approach | Avoid |
|---|---|---|
| Product catalog | Sync into `whatsapp_catalog`; expose via read-only API | Letting the AI scrape PDFs on every message |
| Excel/CSV price list | Import into a `business_knowledge` table | Re-parsing the spreadsheet per call |
| FAQ / policies | Convert to searchable articles, chunked and embedded | Long unstructured blobs |
| Orders / inventory / bookings | API tool calls with strict customer-identity checks | Returning order data without verification |
| CRM | n8n sync with idempotent keys | Direct DB writes from the agent |

### Safety controls (mandatory)

- **Read-only access** to business data by default.
- **Customer verification** before revealing order, payment, or PII.
- **Confidence threshold** — below the threshold, the agent hands off to
  Agents instead of guessing.
- **Hard handoff keywords** — `human`, `agent`, `complaint`, `refund`,
  `cancel` (and any locale-specific equivalents) always trigger handoff.
- **Audit log** — every AI decision (input, retrieved context, prompt,
  output, handoff reason) is persisted for review.
- **Rate limits and per-customer cooldown**, mirroring the existing Auto
  Reply cooldown.
- **Language**: confirm supported languages before going live; add an
  explicit "I don't understand / speak English only" fallback.
- **No medical, legal, or financial advice** unless a domain-specific
  guardrail is approved.

---

## 6. n8n integration

Postora's public WhatsApp events are delivered as outbound webhooks. The
recommended n8n pattern for an AI agent:

```
Postora Webhook
  -> n8n Webhook Trigger (POST)
  -> Identify customer (lookup by phone)
  -> Retrieve business context
       ├── Postgres / HTTP tool: read catalog/FAQ table
       ├── HTTP tool: order / booking / CRM
       └── (optional) Vector store for semantic FAQ search
  -> AI Agent node
       ├── System prompt: brand voice, scope, hard handoff list
       ├── Tool: lookup_order, lookup_faq, lookup_product
       ├── Tool: send_reply (calls Postora /messaging-api)
       └── Tool: assign_to_human (sets agent assignment)
  -> Decision branch
       ├── confident answer  -> send_reply (free text within 24h)
       ├── needs template    -> send_template (uses approved name)
       └── handoff           -> assign_to_human with AI summary
  -> Persist to n8n log + Postora messaging_cache
```

**HMAC verification** — every Postora webhook POST includes an
`X-Webhook-Signature: <hex>` header when a `secret` is configured. Verify
it in n8n with the same `HMAC-SHA256(secret, rawBody)` before any branch
runs. Reject and return `401` on mismatch.

**Idempotency** — the webhook includes a `message_id`; n8n should
de-duplicate on it so retried deliveries do not produce duplicate replies.

### High-demand automations to ship first

1. **Lead qualification** — collect service/product interest, location,
   budget, and consent; create a CRM deal and notify the right agent.
2. **Product advisor** — recommend from the catalog using stock, price,
   and customer needs.
3. **Order tracking** — verify identity, query the order system, return
   live delivery status via a template.
4. **Booking assistant** — check calendar availability, book or
   reschedule, send a reminder template.
5. **Abandoned enquiry follow-up** — trigger a template after consent and
   approved timing.
6. **Support triage** — categorise delivery, billing, technical, refund,
   and complaint requests; route to the right team with the AI summary.
7. **Payment reminder** — send a compliant template with a payment link
   and update on success.
8. **Review collection** — request feedback after delivery/service.
9. **FAQ deflection** — answer routine questions and reduce human load.
10. **VIP escalation** — detect high-value customers or angry sentiment
    and assign a senior agent immediately.

---

## 7. Suitable business types

The WhatsApp + AI-agent stack is most valuable for businesses with high
inbound chat volume, repetitive questions, and a clear catalogue or
booking flow.

- E-commerce stores and retailers
- Restaurants, cafés, and food delivery
- Clinics, dental practices, and salons
- Real estate agencies
- Automotive dealers and service centres
- Travel agencies and hotels
- Education, tutoring, and training centres
- Home services: cleaning, repair, maintenance, pest control
- Gyms and fitness studios
- Agencies and B2B service businesses
- Pharmacies and local delivery businesses
- Any business receiving high volumes of repetitive WhatsApp enquiries

---

## 8. Onboarding checklist (per business)

Use this to qualify a new customer before turning the agent live.

1. **Business type** — e-commerce, clinic, restaurant, service, real
   estate, or other.
2. **Scope of the AI** — FAQs/products only, or also orders, bookings,
   payments, and inventory.
3. **Data source** — Excel, Google Sheets, Postora catalog, Shopify,
   WooCommerce, CRM, ERP, or custom database.
4. **Languages** — Arabic, English, or both.
5. **Always-human topics** — refunds, pricing negotiation, complaints,
   medical/legal advice, order cancellation.
6. **Deployment model** — AI agent inside Postora, or n8n as the first
   integration layer.

Capture the answers in the customer onboarding record so the agent's
system prompt and tool list match the business contract.
