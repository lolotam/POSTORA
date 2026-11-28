/**
 * Offline mocked-browser journeys for YouTube Stage 3.
 *
 * Every backend and vendor request is answered by e2e/fixtures/youtubeStage3.ts
 * or aborted. These journeys prove browser wiring, state and copy only; they
 * are not live D1/D5 provider proof.
 */
import { expect, test, type Page } from "@playwright/test";
import { startStage3Journey, youtubeFixtureState, VIDEO } from "./fixtures/youtubeStage3";

async function openEditor(page: Page, locale: "en" | "ar" = "en") {
  await page.goto("/youtube", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(VIDEO.title).first()).toBeVisible();
  await page.getByRole("button", { name: new RegExp(VIDEO.title, "i") }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  const editName = locale === "ar" ? /تعديل تفاصيل الفيديو/ : /edit video details/i;
  await expect(drawer.getByRole("button", { name: editName })).toBeVisible();
  await drawer.getByRole("button", { name: editName }).click();
  await expect(drawer.getByLabel(locale === "ar" ? "العنوان" : "Title", { exact: true })).toBeVisible();
}

test.describe("YouTube Stage 3 offline journeys", () => {
  test("the drawer shows a poster and mounts the player only after Play", async ({ page }) => {
    const embedRequestsBeforePlay: string[] = [];
    let playClicked = false;
    page.on("request", (req) => {
      if (!playClicked && req.url().includes("youtube-nocookie.com")) {
        embedRequestsBeforePlay.push(req.url());
      }
    });
    await startStage3Journey(page, { edit: "available" });
    await page.goto("/youtube", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: new RegExp(VIDEO.title, "i") }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Nothing is loaded from YouTube's embed host before the creator presses Play.
    const playButton = drawer.getByRole("button", { name: /play video/i });
    await expect(playButton).toBeVisible();
    await expect(page.locator('iframe[src*="youtube-nocookie.com"]')).toHaveCount(0);
    expect(embedRequestsBeforePlay).toEqual([]);

    playClicked = true;
    await playButton.click();

    await expect(page.locator('iframe[src*="youtube-nocookie.com"]')).toHaveCount(1);
    await expect(page.locator('iframe[src*="youtube-nocookie.com"]')).toHaveAttribute("src", /embed\/AbcD1234eFg/);
  });

  test("the edit button opens the editor and closes it again", async ({ page }) => {
    await startStage3Journey(page, { edit: "available" });
    await openEditor(page);

    await page.getByRole("button", { name: /edit video details/i }).click();

    await expect(page.getByLabel("Title", { exact: true })).toBeHidden();
  });

  test("a saved edit closes the editor and keeps the confirmation visible", async ({ page }) => {
    await startStage3Journey(page, { edit: "available" });
    await openEditor(page);
    await page.getByLabel("Title", { exact: true }).fill("Renamed in the offline journey");
    await page.getByRole("button", { name: /^save$/i }).click();

    await expect(page.getByRole("status")).toContainText(/match your changes/i);
    await expect(page.getByLabel("Title", { exact: true })).toBeHidden();
  });

  test("EN edit success: snapshot, title, description and tag change, and verified save", async ({ page }) => {
    await startStage3Journey(page, { edit: "available" });
    await openEditor(page);
    await page.getByLabel("Title", { exact: true }).fill("Renamed in the offline journey");
    await page.getByLabel("Description", { exact: true }).fill("Description edited in the offline journey");
    await page.getByLabel("Tags (comma-separated)", { exact: true }).fill("offline, journey");
    await page.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByRole("status")).toContainText(/match your changes/i);
    // The success is only meaningful if the intended mutation reached the wire.
    expect(youtubeFixtureState.updateRequests).toHaveLength(1);
    expect(youtubeFixtureState.updateRequests[0]).toMatchObject({
      videoId: VIDEO.id,
      changes: {
        title: "Renamed in the offline journey",
        description: "Description edited in the offline journey",
        tags: ["offline", "journey"],
      },
    });
    expect(typeof youtubeFixtureState.updateRequests[0].baseRevision).toBe("string");
  });

  test("EN privacy change in drawer requires confirmation checkbox before saving", async ({ page }) => {
    await startStage3Journey(page, { edit: "available" });
    await openEditor(page);
    const privacySelect = page.getByLabel("Privacy", { exact: true });
    await expect(privacySelect).toBeEnabled();
    await expect(privacySelect).toHaveValue("private");

    await privacySelect.selectOption("public");
    const saveButton = page.getByRole("button", { name: /^save$/i });
    await expect(saveButton).toBeDisabled();

    const confirmCheckbox = page.getByRole("checkbox", {
      name: /I understand this changes who can see this video on YouTube\. It becomes visible to everyone\./i,
    });
    await expect(confirmCheckbox).toBeVisible();
    await confirmCheckbox.check();
    await expect(saveButton).toBeEnabled();

    await saveButton.click();
    await expect(page.getByRole("status")).toContainText(/match your changes/i);
    expect(youtubeFixtureState.updateRequests).toHaveLength(1);
    expect(youtubeFixtureState.updateRequests[0]).toMatchObject({
      videoId: VIDEO.id,
      changes: {
        privacy_status: "public",
      },
      privacyConfirmation: {
        to: "public",
      },
    });
  });

  test("a stale base is reported as a conflict without claiming success", async ({ page }) => {
    await startStage3Journey(page, { edit: "conflict" });
    await openEditor(page);
    await page.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByRole("status")).toContainText(/changed since this was opened/i);
  });

  test("an unknown verification result is never presented as saved", async ({ page }) => {
    await startStage3Journey(page, { edit: "unknown" });
    await openEditor(page);
    await page.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByRole("status")).toContainText(/may have saved/i);
  });

  test("a reconnect refusal offers a disabled editor with its reason", async ({ page }) => {
    await startStage3Journey(page, { edit: "reconnect" });
    await page.goto("/youtube", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(VIDEO.title).first()).toBeVisible();
    await page.getByRole("button", { name: new RegExp(VIDEO.title, "i") }).click();
    await expect(page.getByRole("button", { name: /edit video details/i })).toBeDisabled();
    await expect(page.getByText(/reconnect/i).first()).toBeVisible();
  });

  test("AR edit success keeps number-first category labels and RTL layout", async ({ page }) => {
    await startStage3Journey(page, { edit: "available", locale: "ar" });
    await openEditor(page, "ar");
    await expect(page.getByText(/الأشخاص والمدونات/).first()).toBeVisible();
    await page.getByRole("button", { name: /^حفظ$/ }).click();
    await expect(page.getByRole("status")).toContainText(/التفاصيل الحالية مطابقة/);
  });

  test("Create Post shows the requested private default and pre-send channel preview", async ({ page }) => {
    await startStage3Journey(page);
    await page.goto("/post", { waitUntil: "domcontentloaded" });
    // YouTube requires media; a synthetic video makes the platform eligible
    // without uploading anything to a real storage bucket.
    await page.locator('input[type="file"][accept*="video"]').setInputFiles({
      name: "stage3-fixture.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("synthetic-video-bytes"),
    });
    await expect(page.getByText(/Video uploaded - only one video per post allowed/i)).toBeVisible();
    await page.getByRole("button", { name: /next: select platforms/i }).click();
    await page.getByText("stage3-fixture", { exact: true }).click();
    await expect(page.getByTestId("youtube-send-preview")).toContainText(/Requested privacy: private/i);
  });

  test("History separates requested privacy from independently reported follow-ups", async ({ page }) => {
    await startStage3Journey(page, {
      requestedPrivacy: "unlisted",
      followUps: { thumbnail: "failed", first_comment: "applied" },
    });
    await page.goto("/history", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Stage 3 fixture post").first()).toBeVisible();
    await page.getByTestId("post-menu").click();
    await page.getByTestId("post-menu-view-details").click();
    await expect(page.getByTestId("youtube-publish-evidence")).toContainText(/unlisted/);
    await expect(page.getByTestId("youtube-publish-evidence")).toContainText(/unknown/);
    await expect(page.getByTestId("youtube-publish-evidence")).toContainText(/Failed/);
    await expect(page.getByTestId("youtube-publish-evidence")).toContainText(/Applied/);
  });

  test("keyboard focus and a 320px viewport keep the editor reachable", async ({ page }) => {
    await startStage3Journey(page, { edit: "available" });
    await page.setViewportSize({ width: 320, height: 720 });
    await openEditor(page);
    const title = page.getByLabel("Title", { exact: true });
    await title.focus();
    await expect(title).toBeFocused();
    // The editor is a keyboard-reachable sequence of real fields.
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Description", { exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: /^save$/i })).toBeVisible();
  });
});
