# WhatsApp Docs Page Recreation — Design Spec

**Date:** 2026-07-11  
**Route:** `/messaging/whatsapp/docs`  
**Approved by:** User (Pending review)  

---

## 1. Goal
Recreate and restyle the `/messaging/whatsapp/docs` page in Postora. Replaces the current text-heavy UI with a premium, interactive tab-based dashboard featuring modern CSS/SVG infographics, step-by-step timelines, and visual diagrams. 

This guide will explain the complete WhatsApp user journey, automated messaging rules, and backend limitations in an easy-to-understand, visual layout.

---

## 2. Page Content & Structure

The page will be organized into **five interactive tabs** under a sleek glassmorphic hero header:

```
[Hero Header: WhatsApp Assistant Guide & Diagnostics Link]
└─ [Tab Bar: Connection & Sync | Chatbot Builder | Automated Messaging | Team Inbox | Troubleshooting]
```

### Tab 1: Connection & Sync (History Phasing & QR Steps)
- **Step-by-Step Connection Journey (Interactive Flowchart)**:
  1. **Connect Flow** (WhatsApp Setup → "Connect with Coexistence" → Meta Embedded Signup popup).
  2. **Phone Consent** (Scan QR via WhatsApp Business phone app → Approve chat-history sharing).
  3. **Background Sync** (Postora triggers background sync calls for history & contacts → Data populates the inbox).
  4. **Safety Nets** (Use "Sync phone chats" button in Setup or disconnect/reconnect in phone settings).
- **Phased History Sync (Visual Timeline)**:
  - Explain why all phone chats do not appear immediately using a progress timeline:
    - **Phase 1 (Last 24 hours):** Instantly synced on connect.
    - **Phase 2 (Last 90 days):** Synced in background over the next few minutes/hours.
    - **Phase 3 (90 to 180 days):** Synced in subsequent background waves (requires phone to stay online).
  - **Limitations Banner**:
    - *Group Chats:* Hard Meta limitation — only 1-to-1 conversations sync.
    - *6-Month Cap:* Messages older than 180 days are excluded.
    - *Media Expiry:* Media older than 14 days cannot be downloaded.

### Tab 2: Chatbot Builder (Level 1 vs Level 2)
- **Chatbot Comparison Layout**:
  - **Level 1 (Keyword Auto-Replies):** Local rules-based auto-replies (Keyword/Away) with 5-minute spam loop cooldown.
  - **Level 2 (Real AI Chatbot):** Outbound webhook events (`message.received`) pointing to n8n/Make.com, calling an LLM (OpenAI), and replying via Postora's API (`POST /functions/v1/messaging-api` with `whatsapp_send_message`).
- **AI Chatbot Webhook Flow (Visual SVG Diagram)**:
  - Visual diagram showing: Customer Message → Postora Ingestion → Webhook Event → External n8n Workflow → LLM Completion → Postora API Reply → Customer Phone.
- **The 24-Hour Rule Alert**:
  - Highlights Meta's customer service window constraint: Free-form text allowed within 24 hours of customer's last incoming message. Outside that, must fall back to a Meta-approved template.

### Tab 3: Automated Messaging (The 4 Channels)
- **Visual Matrix**:
  - Auto Replies, Scheduled Messages, Broadcasts, Webhooks.
- **Template Submission Flow**:
  - Explains the prerequisite of creating and submitting templates for Meta approval (`/whatsapp/templates`) to allow sending broadcasts and scheduling messages outside the 24-hour window.

### Tab 4: Team Inbox & Handoff (The Human Inbox)
- **Live Team Workspace Guide**:
  - Covers live conversation thread list, unread badges, quick canned replies, labels/tagging, and agent availability management (Online/Away/Offline, assignment concurrency caps).
- **Human Handoff Workflow Diagram**:
  1. Auto-reply acknowledges query instantly.
  2. If unresolved, assigned to online human agent.
  3. Agent replies using Quick Replies or free text.
  4. Conversation is resolved.

### Tab 5: Troubleshooting FAQ & Diagnostics
- Accordion grouping common setup questions:
  - Error 2388001 (Two-step verification active on phone).
  - Inbound messages not arriving (Webhook checks, subscription fields).
  - Sync error 2593109 (Declined history sharing at QR step).

---

## 3. UI/UX Design System & Tokens

We will use a premium design system tailored to WhatsApp's brand:
- **Palette**: HSL green theme:
  - Main Accent: `#25D366` (Teal-green)
  - Dark Accent: `#128C7E` (Forest-green)
  - Card Bg: `rgba(255, 255, 255, 0.05)` (glassmorphism in dark mode)
  - Text Highlights: HSL matching text rings and custom badges.
- **Micro-animations**: Smooth hover transitions, scaling on tabs, and fade-ins on diagrams.
- **Typography**: Large, bold serifs for page headers and crisp sans-serif text for body elements.
- **Graphics**: Instead of plain placeholders, we will create custom visual assets (e.g., SVG/CSS diagrams, interactive progress meters) and load them dynamically.

---

## 4. Verification Plan

### Automated Tests
- Run Vite dev server and check console for compilation errors.
- Verify TypeScript compilation using `npm run build` or `npx tsc --noEmit`.

### Manual Verification
- Navigate to `/messaging/whatsapp/docs` on localhost.
- Toggle between all tabs, verifying responsiveness, hover effects, and transitions.
- Check that all diagrams render correctly on desktop and mobile viewport sizes.
- Verify that links to Setup, Templates, and webhooks redirect to the correct routes.
