/**
 * The Stage 4 browser journey, EN and AR, against the REAL local handler and
 * the REAL SQL receipt functions on the disposable harness database, with a
 * counting fake provider. The Stage 3 page-route fixture is deliberately not
 * used: it fabricates the function response, so it cannot show the interface
 * reaching the receipt.
 *
 * Run through scripts/stage4-e2e.mjs (one command boots PostgREST, the Deno
 * journey API and the Vite dev server with the right env). Any unexpected
 * external request fails the API server itself.
 */
import { expect, test, type Page } from "@playwright/test";

const API = process.env.STAGE4_API_ORIGIN ?? "http://127.0.0.1:65438";
const OWNER_EMAIL = process.env.STAGE4_OWNER_EMAIL ?? "stage4-journey@example.invalid";
// Generated per run by scripts/stage4-e2e.mjs; there is no default on purpose.
const { STAGE4_OWNER_PASSWORD: OWNER_PASSWORD = "" } = process.env;

async function providerState(): Promise<{ writes: number; writePaths: string[]; writeBodies: unknown[]; reads: number }> {
  const response = await fetch(`${API}/__stage4/provider`);
  return await response.json() as { writes: number; writePaths: string[]; writeBodies: unknown[]; reads: number };
}

async function control(action: string, body?: unknown): Promise<void> {
  const response = await fetch(`${API}/__stage4/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  expect(response.ok, action).toBe(true);
}

const ACCOUNT_ID = process.env.STAGE4_ACCOUNT_ID ?? "6e8b0001-0000-4000-8000-000000000001";

/** A direct call to the handler as the signed-in owner (a forged client). */
async function callManager(body: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; data?: unknown }> {
  const session = await (await fetch(`${API}/auth/v1/token`, { method: "POST" })).json() as { access_token: string };
  const response = await fetch(`${API}/functions/v1/comment-manager`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.json() as { ok: boolean; reason?: string; data?: unknown };
}

/** Sign in through the real auth page; the shim mints the owner session. */
async function signIn(page: Page, locale: "en" | "ar"): Promise<void> {
  await page.addInitScript((lang) => {
    localStorage.setItem("postora.language", lang);
  }, locale);
  await page.goto("/auth");
  await page.fill('input[placeholder="you@example.com"]', OWNER_EMAIL);
  await page.fill('input[type="password"]', OWNER_PASSWORD);
  await page.click('button:has-text("Sign In")');
  await page.waitForURL("**/dashboard", { timeout: 45_000 });
}

async function openInbox(page: Page): Promise<void> {
  await page.goto("/comments?platform=youtube");
  await expect(page.getByRole("option", { name: "Journey video" })).toBeVisible({ timeout: 30_000 });
}

/** Text unique to this run: the SQL fence remembers a recent comment for 10 minutes. */
const RUN = Date.now().toString(36);
let textSeq = 0;
function uniqueText(label: string): string {
  textSeq += 1;
  return `${label} ${RUN}-${textSeq}`;
}

async function submitTopLevelComment(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId("yt-stage4-composer");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill(text);
  await composer.getByRole("button", { name: /^(Comment|تعليق)$/ }).click();
}

for (const locale of ["en", "ar"] as const) {
  test.describe(`Stage 4 journey (${locale})`, { tag: `@${locale}` }, () => {
    test.beforeEach(async ({ page }) => {
      await control("reset");
      await control("capabilities", { on: true });
      await signIn(page, locale);
      await openInbox(page);
    });

    test("empty upload, post, reload, edit own, foreign edit refused", async ({ page }) => {
      await page.getByRole("option", { name: "Empty upload" }).click();
      await expect(page.getByTestId("yt-stage4-empty")).toBeVisible();

      await submitTopLevelComment(page, uniqueText("first deliberate comment"));
      await expect(page.getByTestId("yt-stage4-notice")).toContainText(/Posted|تم النشر/);
      expect((await providerState()).writes).toBe(1);

      // Reload: the durable identity was consumed and the composer is free.
      await page.reload();
      await openInbox(page);
      await expect(page.getByTestId("yt-stage4-composer")).toBeVisible();

      // On the journey video, the channel's own comment can be edited.
      await page.getByRole("option", { name: "Journey video" }).click();
      await expect(page.getByText("the channel's own comment")).toBeVisible();
      await page.getByRole("button", { name: /^(Edit|تعديل)$/ }).first().click();
      const editor = page.getByTestId("yt-stage4-composer").filter({ has: page.getByPlaceholder(/Edit your comment|عدِّل تعليقك/) });
      await editor.locator("textarea").fill(uniqueText("edited by the journey"));
      await editor.getByRole("button", { name: /^(Save|حفظ)$/ }).click();
      await expect(page.getByTestId("yt-stage4-notice")).toContainText(/Posted|تم النشر/);
      expect((await providerState()).writes).toBe(2);

      // A foreign reply: the UI offers no Edit, and the SERVER refuses an edit
      // addressed at it anyway, with zero provider writes.
      const replyPage = page.waitForResponse((r) =>
        r.url().includes("/functions/v1/comment-manager") && (r.request().postData() ?? "").includes("youtube_reply_page"));
      await page.getByRole("button", { name: /^(Load replies|تحميل الردود)$/ }).first().click();
      const replyPayload = await (await replyPage).json() as { data: { items: Array<{ handle: string; text: string; is_own: boolean }> } };
      await expect(page.getByText("reply page one", { exact: true })).toBeVisible({ timeout: 10_000 });
      const foreignRow = replyPayload.data.items.find((row) => row.text === "reply page one");
      expect(foreignRow?.is_own).toBe(false);
      const foreignCard = page.locator('[data-testid="yt-stage4-replies"] .p-4', { hasText: "reply page one" }).first();
      await expect(foreignCard.getByRole("button", { name: /^(Edit|تعديل)$/ })).toHaveCount(0);

      const before = (await providerState()).writes;
      const refused = await callManager({
        action: "youtube_edit_comment",
        social_account_id: ACCOUNT_ID,
        target_handle: foreignRow!.handle,
        text: "forged edit of someone else's comment",
        operation_id: crypto.randomUUID(),
      });
      expect(refused.ok).toBe(false);
      expect(refused.reason).toBe("target_not_owned");
      expect((await providerState()).writes).toBe(before);
    });

    test("reply to a comment, then delete the channel's own comment", async ({ page }) => {
      await page.getByRole("option", { name: "Journey video" }).click();
      const viewerCard = page.getByText("a viewer's comment").locator("xpath=ancestor::div[contains(@class,'p-4')][1]");
      await expect(viewerCard).toBeVisible({ timeout: 10_000 });

      // Reply: exactly one POST comments (comments.insert) naming the parent.
      await viewerCard.getByRole("button", { name: /^(Reply|رد)$/ }).click();
      const thanks = uniqueText("thanks for watching");
      await viewerCard.locator("textarea").fill(thanks);
      await viewerCard.getByRole("button", { name: /^(Reply|رد)$/ }).last().click();
      await expect(page.getByTestId("yt-stage4-notice")).toContainText(/Posted|تم النشر/);
      let state = await providerState();
      expect(state.writes).toBe(1);
      expect(state.writePaths[0]).toMatch(/^POST comments\?/);
      expect(state.writeBodies[0]).toMatchObject({ snippet: { parentId: "cmt-journey-viewer", textOriginal: thanks } });

      // Delete the channel's own comment through the existing delete path.
      const ownCard = page.getByText("the channel's own comment").locator("xpath=ancestor::div[contains(@class,'p-4')][1]");
      await ownCard.getByRole("button", { name: /^(Delete|حذف)$/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect((await providerState()).writes).toBe(1);
      await page.getByRole("dialog").getByRole("button", { name: /^(Delete|حذف)$/ }).click();
      await expect(page.getByTestId("yt-stage4-notice")).toContainText(/Deleted|تم الحذف/);
      state = await providerState();
      expect(state.writes).toBe(2);
      expect(state.writePaths[1]).toBe("DELETE comments?id=cmt-journey-top");
      // The viewer's comment has no Delete.
      await expect(viewerCard.getByRole("button", { name: /^(Delete|حذف)$/ })).toHaveCount(0);
    });

    test("three reply pages with one retry", async ({ page }) => {
      await page.getByRole("option", { name: "Journey video" }).click();
      await control("fail-reply-page-once");
      await page.getByRole("button", { name: /^(Load replies|تحميل الردود)$/ }).first().click();
      await expect(page.getByText("reply page one", { exact: true })).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /(More replies|المزيد من الردود)/ }).click();
      // The middle page fails once and only that page is retried.
      await expect(page.getByText("reply page two", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/A page of replies failed to load|فشل تحميل صفحة من الردود/)).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /(Retry this page|إعادة محاولة هذه الصفحة)/ }).click();
      await expect(page.getByText("reply page two b")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("reply page one", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: /(More replies|المزيد من الردود)/ }).click();
      await expect(page.getByText("reply page three")).toBeVisible({ timeout: 10_000 });
      expect((await providerState()).writes).toBe(0);
    });

    test("publish from the held list, no Hold on a published row, reject and reject-with-ban", async ({ page }) => {
      await page.getByRole("option", { name: "Journey video" }).click();
      await page.getByRole("tab", { name: /(Held for review|بانتظار المراجعة)/ }).click();
      await expect(page.getByText("held by the moderator")).toBeVisible({ timeout: 10_000 });

      // Publish the held comment.
      await page.getByRole("button", { name: /^(Publish|نشر)$/ }).first().click();
      await expect(page.getByTestId("yt-stage4-notice")).toContainText(/Done|تم/);
      await expect.poll(async () => (await providerState()).writes, { timeout: 10_000 }).toBe(1);

      // Back on Published: a published comment cannot return to held, so no
      // row offers Hold; then reject with confirmation.
      await page.getByRole("tab", { name: /^(Published|منشورة)/ }).click();
      await expect(page.getByText("the channel's own comment")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("button", { name: /^(Hold|حجز)$/ })).toHaveCount(0);

      await page.getByRole("button", { name: /^(Reject|رفض)$/ }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(/cannot be published again|لا يمكن نشر/);
      await dialog.getByRole("button", { name: /^(Cancel|إلغاء)/ }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      expect((await providerState()).writes).toBe(1);

      // Reject and ban through both dialogs, on a VIEWER's comment: a ban is
      // refused for the channel's own comment (no other author to ban).
      const viewerCard = page.getByText("a viewer's comment").locator("xpath=ancestor::div[contains(@class,'p-4')][1]");
      await expect(viewerCard).toBeVisible();
      await viewerCard.getByRole("button", { name: /^(Reject|رفض)$/ }).click();
      await page.getByRole("dialog").getByRole("checkbox").check();
      await page.getByRole("dialog").getByRole("button", { name: /(Continue|متابعة)/ }).click();
      await expect(page.getByRole("dialog")).toContainText(/cannot show whether an author is banned|لا تستطيع بوستورا إظهار/);
      await page.getByRole("dialog").getByRole("button", { name: /(Reject and ban|رفض وحظر)/ }).click();
      // The notice from the earlier Publish is still on screen, so wait on the
      // provider's own count for the second write before reading its path.
      await expect.poll(async () => (await providerState()).writes, { timeout: 15_000 }).toBe(2);
      await expect(page.getByTestId("yt-stage4-notice")).toContainText(/Done|تم/);
      const paths = (await providerState()).writePaths;
      expect(paths.length).toBe(2);
      expect(paths[1]).toContain("setModerationStatus");
      expect(paths[1]).toContain("banAuthor=true");
      // The one request carried the viewer's comment id and the rejected status.
      expect(paths[1]).toContain("id=cmt-journey-viewer");
      expect(paths[1]).toContain("moderationStatus=rejected");
      // The cancelled Reject never sent anything, and exactly one request carried banAuthor.
      expect(paths.filter((p) => p.includes("banAuthor")).length).toBe(1);
    });
  });
}

test.describe("Stage 4 fences across tabs and reloads (en)", () => {
  test.beforeEach(async ({ browser }) => {
    await control("reset");
    await control("capabilities", { on: true });
    void browser;
  });

  test("the same submit from two tabs produces exactly one provider write", async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    // One browser context = one signed-in session shared by both tabs (as two
    // real tabs of one browser share storage); signing in twice would bounce
    // the second tab off /auth.
    await signIn(pageA, "en");
    await openInbox(pageA);
    await openInbox(pageB);

    const onlyOnce = uniqueText("only once");
    await submitTopLevelComment(pageA, onlyOnce);
    await expect(pageA.getByTestId("yt-stage4-notice")).toContainText(/Posted/);
    await submitTopLevelComment(pageB, onlyOnce);
    await expect(pageB.getByRole("alert").first()).toBeVisible({ timeout: 10_000 });

    const { writes } = await providerState();
    expect(writes).toBe(1);
    await context.close();
  });

  test("the same submit clicked in two tabs AT THE SAME TIME produces exactly one provider write", async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    // One browser context = one signed-in session shared by both tabs (as two
    // real tabs of one browser share storage); signing in twice would bounce
    // the second tab off /auth.
    await signIn(pageA, "en");
    await openInbox(pageA);
    await openInbox(pageB);
    const racing = uniqueText("racing comment");
    for (const tab of [pageA, pageB]) {
      await tab.getByTestId("yt-stage4-composer").locator("textarea").fill(racing);
    }
    await Promise.all([pageA, pageB].map((tab) =>
      tab.getByTestId("yt-stage4-composer").getByRole("button", { name: /^Comment$/ }).click()));
    // Both tabs settle on an answer: one is accepted, the other is refused or
    // reported as already recorded. Each composer shows its own outcome line.
    const lines: string[] = [];
    for (const tab of [pageA, pageB]) {
      const line = tab.getByTestId("yt-stage4-composer").locator("[role=status], [role=alert]").first();
      await expect(line).toBeVisible({ timeout: 20_000 });
      lines.push(await line.innerText());
    }
    // Exactly one tab was accepted; the other got the fence's reason (an
    // unresolved twin, or one that was just posted).
    expect(lines.filter((line) => /Accepted by YouTube/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /may already be on its way|was just posted|already recorded/.test(line))).toHaveLength(1);
    expect((await providerState()).writes).toBe(1);
    await context.close();
  });

  test("a lost response after settlement recovers by status with no replay", async ({ page }) => {
    await signIn(page, "en");
    await openInbox(page);
    await control("drop-next-response");
    const dropped = page.waitForResponse((reply) => reply.url().includes("/functions/v1/comment-manager") && reply.status() === 599);
    await submitTopLevelComment(page, uniqueText("lost in transit"));
    // The browser saw an error; the receipt settled inside the handler. The
    // composer now offers a status check instead of an error with no way out.
    await dropped;
    await expect(page.getByRole("button", { name: /Check status|تحقق من الحالة/ })).toBeVisible({ timeout: 10_000 });
    expect((await providerState()).writes).toBe(1);

    await page.reload();
    await openInbox(page);
    await expect(page.getByTestId("yt-stage4-recovered")).toContainText(/accepted by YouTube|قبِله يوتيوب/, { timeout: 15_000 });
    expect((await providerState()).writes).toBe(1);
  });

  test("an indeterminate create after reload shows no resend", async ({ page }) => {
    await signIn(page, "en");
    await openInbox(page);
    await control("indeterminate-next-create");
    const ghost = uniqueText("ghost comment");
    await submitTopLevelComment(page, ghost);
    await expect(page.getByRole("alert").first()).toContainText(/may or may not|قد يكون|لم يُطبَّق/, { timeout: 10_000 });
    await page.reload();
    await openInbox(page);
    await expect(page.getByTestId("yt-stage4-recovered")).toContainText(/may or may not|قد يكون/, { timeout: 15_000 });
    // The earlier create stays unresolved on the server: the same text under a
    // new key is refused by the logical fence, and nothing reaches YouTube.
    await submitTopLevelComment(page, ghost);
    await expect(page.getByText(/may already be on its way|قد يكون التعليق نفسه/).first()).toBeVisible({ timeout: 10_000 });
    expect((await providerState()).writes).toBe(1);
  });

  test("every capability off shows the baseline inbox and still recovers receipts", async ({ page }) => {
    await signIn(page, "en");
    await openInbox(page);
    await control("drop-next-response");
    const droppedBeforeSwitch = page.waitForResponse((reply) => reply.url().includes("/functions/v1/comment-manager") && reply.status() === 599);
    await submitTopLevelComment(page, uniqueText("before the switch"));
    await droppedBeforeSwitch;

    await control("capabilities", { on: false });
    await page.reload();
    await page.goto("/comments?platform=youtube");
    // The baseline inbox (the legacy CommentList surface), not the Stage 4 UI.
    await expect(page.getByTestId("yt-stage4-composer")).toBeHidden();
    // The standalone recovery banner still names the outcome.
    await expect(page.getByTestId("yt-stage4-recovered-standalone")).toContainText(/accepted by YouTube|قبِله يوتيوب/, { timeout: 15_000 });
    expect((await providerState()).writes).toBe(1);
  });
});
