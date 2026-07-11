# WhatsApp Docs Page Recreation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recreate and restyle the WhatsApp documentation page (`src/pages/whatsapp/Docs.tsx`) with a premium, tab-based layout featuring rich visual infographics, diagrams, and explanation of sync phases, chatbot setups, and automated messaging.

**Architecture:** We will generate custom visual illustrations using the image generator tool, place them in the public folder, and implement a responsive tabbed workspace inside the existing page. We will use glassmorphism styles, Framer Motion (or simple CSS transitions), Lucide icons, and custom CSS/SVG-based inline widgets.

**Tech Stack:** React, Tailwind CSS, Lucide icons, Framer Motion (already in project).

---

### Task 1: Generate and Set Up Visual Assets

**Files:**
- Create: `public/images/whatsapp/whatsapp-sync-timeline.png`
- Create: `public/images/whatsapp/whatsapp-chatbot-flow.png`
- Create: `public/images/whatsapp/whatsapp-team-inbox.png`

- [ ] **Step 1: Generate WhatsApp Sync Timeline Asset**
  - Run the `generate_image` tool to create `whatsapp_sync_timeline.png` with prompt:
    `A premium, minimalist dark-mode infographic illustrating a data sync timeline with clock icons, floating data nodes, and three progressive waves of history (24h, 90d, 180d) in neon emerald and teal tones, high tech aesthetic, clean design, no text placeholders.`
- [ ] **Step 2: Generate WhatsApp Chatbot Workflow Asset**
  - Run the `generate_image` tool to create `whatsapp_chatbot_flow.png` with prompt:
    `A modern glassmorphism tech diagram showing a messaging webhook flow: a phone icon, a server icon, a workflow node (n8n), and an AI brain node, connected by glowing green trails, dark mode, high tech interface, minimalist, no text.`
- [ ] **Step 3: Generate WhatsApp Team Inbox Handoff Asset**
  - Run the `generate_image` tool to create `whatsapp_team_inbox.png` with prompt:
    `A beautiful visual of a collaborative team inbox dashboard with multiple profile avatars, incoming message bubbles, and green assignment badges, isometric style, dark mode, sleek, modern UI, no text.`
- [ ] **Step 4: Copy/Move Generated Assets to Workspace**
  - Create directory `public/images/whatsapp/` if not exists.
  - Move the three generated images from the artifact directory to `public/images/whatsapp/`.
- [ ] **Step 5: Verify images exist in path**
  - Run a shell command to list `public/images/whatsapp/` and verify the files are present.
  - Commit these assets to git.

---

### Task 2: Build Interactive Tabs & Header Layout

**Files:**
- Modify: `src/pages/whatsapp/Docs.tsx`
- Test: Build project to check syntax.

- [ ] **Step 1: Update Imports and Section Structures**
  - Add state hook for active tabs.
  - Replace static `DocsCard` calls with a dynamic tab selection container.
  - Use Lucide icons matching each tab category.
- [ ] **Step 2: Add Glassmorphic Header and Tab Selector**
  - Add a styled header with a dark/light emerald gradient.
  - Implement tabs: "Connection & Sync", "Chatbot Builder", "Automated Messaging", "Team Inbox", and "FAQs & Diagnostics".
- [ ] **Step 3: Verify basic tab switching works**
  - Build and verify the component compiles successfully.
  - Commit layout shell.

---

### Task 3: Implement Connection & Sync Content (Tab 1)

**Files:**
- Modify: `src/pages/whatsapp/Docs.tsx`

- [ ] **Step 1: Implement Step-by-Step Onboarding Workflow**
  - Render a clean visual card timeline outlining:
    - Step 1: Click "Connect with Coexistence" in WhatsApp Setup page.
    - Step 2: Scan QR with WhatsApp Business app on phone and approve history sharing.
    - Step 3: Sync triggers automatically in the background (no manual curl required!).
    - Step 4: Use "Sync phone chats" button in Setup if retry is needed.
- [ ] **Step 2: Implement Phased Sync Timeline Card**
  - Render the `whatsapp-sync-timeline.png` image with a side-by-side textual list detailing the 3 waves (24h, 90d, 180d) and the limitations (no group chats, 6-month cap, 14-day media expiry).
- [ ] **Step 3: Commit Connection Tab**
  - Check compilation.
  - Commit files.

---

### Task 4: Implement Chatbot Builder & 24h Window Content (Tab 2)

**Files:**
- Modify: `src/pages/whatsapp/Docs.tsx`

- [ ] **Step 1: Implement Level 1 vs Level 2 Comparison Card**
  - Render a responsive split layout comparing:
    - Level 1: Keyword Auto-replies (built-in, rules-based, keyword/away, 5m cooldown).
    - Level 2: Real AI Chatbot (webhook triggers → external n8n workflow → LLM OpenAI → Postora API send).
- [ ] **Step 2: Render AI Chatbot Webhook Flow Diagram**
  - Render the `whatsapp-chatbot-flow.png` image accompanied by instructions on how to set up the outbound webhook and verify signature.
- [ ] **Step 3: Add 24-Hour Rule Alert Box**
  - Add a distinct visual alert box explaining the 24-hour service window limit and template fallback.
- [ ] **Step 4: Commit Chatbot Tab**
  - Verify compile and commit.

---

### Task 5: Implement Automated Messaging & Team Inbox Content (Tabs 3 & 4)

**Files:**
- Modify: `src/pages/whatsapp/Docs.tsx`

- [ ] **Step 1: Implement Automated Channels Grid (Tab 3)**
  - Add the 4-channel matrix grid (Auto Replies, Scheduled, Broadcasts, Webhooks) and explain template prerequisites.
- [ ] **Step 2: Implement Human Team Inbox Workflow (Tab 4)**
  - Render the `whatsapp-team-inbox.png` image and add a step-by-step description of conversation lists, quick canned replies, labels, agent status management, and concurrent chat limits.
- [ ] **Step 3: Commit Tabs 3 & 4**
  - Verify compile and commit.

---

### Task 6: Implement Troubleshooting Accordions & Diagnostics (Tab 5)

**Files:**
- Modify: `src/pages/whatsapp/Docs.tsx`

- [ ] **Step 1: Update FAQ Accordion Questions**
  - Add solutions for Error 2388001 (Two-step verification active on phone).
  - Add details for missing messages ( webhook configuration and webhook fields like `messages`).
  - Add new section for Sync Error 2593109 (Declined history sharing at QR step) and how to resolve it (disconnect in phone settings and reconnect).
- [ ] **Step 2: Add Diagnostic Tool Reference Card**
  - Add a card reminding the user about the Diagnostic tools on the Setup page.
- [ ] **Step 3: Final Build & Verify**
  - Run project build locally to ensure no TypeScript or CSS errors.
  - Commit final documentation changes.
