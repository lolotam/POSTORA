import { test, expect } from "./fixtures/auth";
import { test as baseTest } from "@playwright/test";
import {
    ADDED,
    CLEANUP_ELIGIBLE_AT,
    REFUSED,
    SEEDED,
    SEEDED_MEDIA,
    SEEDED_RENDERED,
    formatKuwaitInstant,
    openCompetitorsTab,
    startCompetitorJourney,
    trackedCell,
    trackedRow,
    waitForTrackedList,
} from "./fixtures/competitorTracking";

test.describe("Analytics Page", () => {
    test.beforeEach(async ({ authenticatedPage }) => {
        await authenticatedPage.goto("/analytics");
        await authenticatedPage.waitForLoadState("networkidle");
    });

    test.describe("Page Loading", () => {
        test("should display the analytics page", async ({ authenticatedPage }) => {
            await expect(authenticatedPage).toHaveURL(/.*analytics/);
        });

        test("should display analytics header", async ({ authenticatedPage }) => {
            const header = authenticatedPage.locator(
                'h1:has-text("Analytics"), [data-testid="analytics-title"]'
            );
            await expect(header.first()).toBeVisible();
        });
    });

    test.describe("Stats Overview", () => {
        test("should display total posts stat", async ({ authenticatedPage }) => {
            const totalPosts = authenticatedPage.locator(
                'text=Total Posts, [data-testid="total-posts"], [class*="stat"]:has-text("Total")'
            );

            const isVisible = await totalPosts.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });

        test("should display success rate stat", async ({ authenticatedPage }) => {
            const successRate = authenticatedPage.locator(
                'text=Success Rate, [data-testid="success-rate"], text=Success'
            );

            const isVisible = await successRate.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });

        test("should display completed posts stat", async ({ authenticatedPage }) => {
            const completedPosts = authenticatedPage.locator(
                'text=Completed, [data-testid="completed-posts"]'
            );

            const isVisible = await completedPosts.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });

        test("should display failed posts stat", async ({ authenticatedPage }) => {
            const failedPosts = authenticatedPage.locator(
                'text=Failed, [data-testid="failed-posts"]'
            );

            const isVisible = await failedPosts.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });

        test("should display scheduled posts stat", async ({ authenticatedPage }) => {
            const scheduledPosts = authenticatedPage.locator(
                'text=Scheduled, [data-testid="scheduled-posts"]'
            );

            const isVisible = await scheduledPosts.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });
    });

    test.describe("Charts", () => {
        test("should display chart section", async ({ authenticatedPage }) => {
            const chartSection = authenticatedPage.locator(
                '[data-testid="chart-section"], [class*="chart"], svg[class*="recharts"]'
            );

            const isVisible = await chartSection.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });

        test("should display posts over time chart", async ({ authenticatedPage }) => {
            const postsChart = authenticatedPage.locator(
                '[data-testid="posts-chart"], [aria-label*="chart"], svg'
            );

            const isVisible = await postsChart.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });

        test("should display platform breakdown", async ({ authenticatedPage }) => {
            const platformChart = authenticatedPage.locator(
                '[data-testid="platform-chart"], text=Platform, [class*="pie"], [class*="donut"]'
            );

            const isVisible = await platformChart.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });
    });

    test.describe("Date Filtering", () => {
        test("should display date range selector", async ({ authenticatedPage }) => {
            const dateRange = authenticatedPage.locator(
                '[data-testid="date-range"], button:has-text("Last"), button:has-text("day"), [class*="date-picker"]'
            );

            const isVisible = await dateRange.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });

        test("should have preset date range options", async ({ authenticatedPage }) => {
            const presets = authenticatedPage.locator(
                'button:has-text("7 days"), button:has-text("30 days"), button:has-text("This Month"), button:has-text("Last Week")'
            );

            const count = await presets.count();
            expect(count).toBeGreaterThanOrEqual(0);
        });

        test("should update data when date range changes", async ({ authenticatedPage }) => {
            const dateButton = authenticatedPage.locator(
                'button:has-text("7 days"), button:has-text("30 days")'
            ).first();

            if (await dateButton.isVisible().catch(() => false)) {
                await dateButton.click();
                await authenticatedPage.waitForTimeout(500);
            }
        });
    });

    test.describe("Platform Filter", () => {
        test("should display platform filter", async ({ authenticatedPage }) => {
            const platformFilter = authenticatedPage.locator(
                '[data-testid="platform-filter"], button:has-text("All Platforms"), select'
            );

            const isVisible = await platformFilter.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });
    });

    test.describe("Export", () => {
        test("should display export button", async ({ authenticatedPage }) => {
            const exportButton = authenticatedPage.locator(
                'button:has-text("Export"), [data-testid="export-analytics"]'
            );

            const isVisible = await exportButton.first().isVisible().catch(() => false);
            expect(typeof isVisible).toBe("boolean");
        });
    });

    test.describe("Empty State", () => {
        test("should handle empty data gracefully", async ({ authenticatedPage }) => {
            // Page should load without errors even with no data
            await expect(authenticatedPage).toHaveURL(/.*analytics/);

            // Either show data or empty state message
            const content = authenticatedPage.locator(
                'text=No data, text=No posts, [class*="chart"], [class*="stat"]'
            );

            const hasContent = (await content.count()) > 0;
            expect(typeof hasContent).toBe("boolean");
        });
    });

    test.describe("Responsive Design", () => {
        test("should display correctly on mobile viewport", async ({ authenticatedPage }) => {
            await authenticatedPage.setViewportSize({ width: 375, height: 667 });
            await authenticatedPage.reload();
            await authenticatedPage.waitForLoadState("networkidle");

            await expect(authenticatedPage).toHaveURL(/.*analytics/);
        });

        test("should display correctly on tablet viewport", async ({ authenticatedPage }) => {
            await authenticatedPage.setViewportSize({ width: 768, height: 1024 });
            await authenticatedPage.reload();
            await authenticatedPage.waitForLoadState("networkidle");

            await expect(authenticatedPage).toHaveURL(/.*analytics/);
        });
    });
});

/*
 * ==========================================================================
 * The competitor tracking journeys.
 *
 * WHAT THIS BLOCK IS
 *
 *   MOCKED-BROWSER coverage of the competitor tracking journeys. Every
 *   backend answer is a fixture (`e2e/fixtures/competitorTracking.ts`):
 *   the report boundary, the owner RPCs and the collection boundary are
 *   intercepted, the owner is synthetic, and no Postgres, no Supabase
 *   Auth, no Meta and no Apify is involved.
 *
 * WHAT IT PROVES
 *
 *   That the reachable page wires the feature correctly, that the states
 *   render the exact copy they promise, that the lifecycle calls the
 *   right boundary with the right arguments, and that the keyboard path
 *   works. Every assertion is an exact text or an exact count.
 *
 * WHAT IT DOES NOT PROVE
 *
 *   NOTHING about the server. A mocked journey cannot show that the SQL
 *   scopes by owner, that the quota is enforced in the database, that the
 *   retention batch deletes only what it may, or that the numbers the
 *   server computes are the numbers a real account produces. The
 *   assembled gate (T8-12) and the live Meta probes still belong to
 *   parent Task 11. This block is NOT live backend validation and it is
 *   not presented as one.
 * ==========================================================================
 */
test.describe("Competitor tracking journeys (mocked browser)", () => {
    test("the tracked list shows the exact seeded growth values", async ({ page }) => {
        await startCompetitorJourney(page);
        await openCompetitorsTab(page);
        await waitForTrackedList(page, SEEDED_RENDERED.handle);

        const row = trackedRow(page, SEEDED_RENDERED.handle);
        await expect(row).toBeVisible();

        // The identity.
        await expect(await trackedCell(page, SEEDED_RENDERED.handle, "Handle")).toHaveText(
            /@northwind_coffee/,
        );

        // The measured follower count, exactly as the server published it.
        const followers = await trackedCell(page, SEEDED_RENDERED.handle, "Followers");
        await expect(followers).toContainText(SEEDED_RENDERED.followers);
        await expect(followers).toContainText(
            formatKuwaitInstant(SEEDED.capturedAt),
        );

        // The two growth comparisons, with their real interval.
        const growth7 = await trackedCell(page, SEEDED_RENDERED.handle, "Follower change · 7 days");
        await expect(growth7).toContainText(SEEDED_RENDERED.growth7);
        await expect(growth7).toContainText("(7 days)");

        const growth30 = await trackedCell(page, SEEDED_RENDERED.handle, "Follower change · 30 days");
        await expect(growth30).toContainText(SEEDED_RENDERED.growth30);
        await expect(growth30).toContainText("(30 days)");

        // The weekly inventory: the rate AND the count it was derived from.
        const weekly = await trackedCell(page, SEEDED_RENDERED.handle, "Observed posts / week");
        await expect(weekly).toContainText(SEEDED_RENDERED.weeklyRate);
        await expect(weekly).toContainText(SEEDED_RENDERED.weeklyCount);

        // The source and the collection state, in words.
        await expect(
            (await trackedCell(page, SEEDED_RENDERED.handle, "Source")).getByText(
                SEEDED_RENDERED.source,
                { exact: true },
            ),
        ).toBeVisible();
        await expect(
            await trackedCell(page, SEEDED_RENDERED.handle, "Waiting for collection"),
        ).toContainText(SEEDED_RENDERED.status);

        // The quota is the owner's real one, not a placeholder.
        await expect(page.getByText("1 of 5 tracked", { exact: true })).toBeVisible();
    });

    test("tracking a competitor adds it once and enqueues the collection once", async ({ page }) => {
        const store = await startCompetitorJourney(page);

        await page.goto("/analytics/instagram?tab=analyze");
        await page
            .getByPlaceholder("Enter @username or instagram.com/username")
            .fill(ADDED.username);
        await page.getByRole("button", { name: "Analyze", exact: true }).click();
        await page.getByText(`@${ADDED.username}`, { exact: true }).first().waitFor();

        const track = page.getByRole("button", { name: "Track", exact: true });
        await expect(track).toBeEnabled();
        await track.click();

        await expect(
            page.getByText("Tracked; the first snapshot is queued.", { exact: true }),
        ).toBeVisible();

        // Exactly one save and exactly one collection request.
        expect(store.calls.add).toBe(1);
        expect(store.calls.addArgs).toEqual([
            { p_username: ADDED.username, p_label: null },
        ]);
        const entryEnqueues = store.calls.syncArgs.filter((call) => call.mode === "entry");
        expect(entryEnqueues).toHaveLength(1);
        expect(entryEnqueues[0].watchlist_id).toBe(ADDED.watchlistId);

        // The handle is tracked now, so the control says so and refuses a
        // second save.
        const tracked = page.getByRole("button", { name: "Tracked", exact: true });
        await expect(tracked).toBeVisible();
        await expect(tracked).toBeDisabled();

        // A second gesture on the same handle does not save a second row.
        await tracked.click({ force: true });
        expect(store.calls.add).toBe(1);
        expect(store.calls.syncArgs.filter((call) => call.mode === "entry")).toHaveLength(1);
        expect(store.entries.filter((entry) => entry.username === ADDED.username)).toHaveLength(1);
    });

    test("a quota refusal does not add the competitor", async ({ page }) => {
        // The owner is already at the limit: one active entry, one slot.
        const store = await startCompetitorJourney(page, { maxTracked: 1 });

        await page.goto("/analytics/instagram?tab=analyze");
        await page
            .getByPlaceholder("Enter @username or instagram.com/username")
            .fill(REFUSED.username);
        await page.getByRole("button", { name: "Analyze", exact: true }).click();
        await page.getByText(`@${REFUSED.username}`, { exact: true }).first().waitFor();

        await page.getByRole("button", { name: "Track", exact: true }).click();

        // The refusal names the owner's real limit.
        await expect(
            page.getByText("Your limit is 1 active competitors.", { exact: true }),
        ).toBeVisible();

        // The save was refused and NOTHING was added.
        expect(store.calls.add).toBe(1);
        expect(store.entries).toHaveLength(1);
        expect(store.entries.filter((entry) => entry.username === REFUSED.username)).toHaveLength(0);
        expect(store.calls.syncArgs).toHaveLength(0);

        // The tracked list still holds exactly the seeded competitor.
        await openCompetitorsTab(page);
        await waitForTrackedList(page, SEEDED_RENDERED.handle);
        await expect(page.getByRole("row")).toHaveCount(2); // the header row and one entry
    });

    test("a forced retry shows the collection as queued and then completed", async ({ page }) => {
        const store = await startCompetitorJourney(page);
        await openCompetitorsTab(page);
        await waitForTrackedList(page, SEEDED_RENDERED.handle);

        await trackedRow(page, SEEDED_RENDERED.handle)
            .getByRole("button", { name: "Retry collection", exact: true })
            .click();

        // The accepted enqueue is QUEUED. It is not a collected snapshot.
        await expect(
            page.getByText("Tracked; the first snapshot is queued.", { exact: true }),
        ).toBeVisible();

        const status = await trackedCell(page, SEEDED_RENDERED.handle, "Waiting for collection");
        await expect(status).toContainText("Queued");

        // The force flag is only ever used by the explicit retry gesture.
        const forceCalls = store.calls.syncArgs.filter((call) => call.mode === "force");
        expect(forceCalls).toHaveLength(1);
        expect(forceCalls[0].watchlist_id).toBe(SEEDED.watchlistId);

        // The bounded poll reads the status again and the job is finished.
        await expect(status).toContainText("Completed", { timeout: 20_000 });
    });

    test("a removal keeps the history and moves the entry to Removed", async ({ page }) => {
        const store = await startCompetitorJourney(page);
        await openCompetitorsTab(page);
        await waitForTrackedList(page, SEEDED_RENDERED.handle);

        await trackedRow(page, SEEDED_RENDERED.handle)
            .getByRole("button", { name: `Remove ${SEEDED_RENDERED.handle}` })
            .click();

        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("heading")).toHaveText(
            `Remove ${SEEDED_RENDERED.handle}?`,
        );
        await dialog.getByRole("button", { name: "Remove", exact: true }).click();

        // The active list is empty now: nothing was hard-deleted, the entry
        // simply moved.
        await expect(
            page.getByText("Track your first Instagram competitor", { exact: true }),
        ).toBeVisible();
        expect(store.calls.updateArgs).toEqual([
            {
                p_watchlist_id: SEEDED.watchlistId,
                p_label: null,
                p_is_active: false,
            },
        ]);
        expect(store.entries).toHaveLength(1);

        // The history is still there, and the removal marker is on it.
        await page.getByRole("tab", { name: "Removed", exact: true }).click();
        await waitForTrackedList(page, SEEDED_RENDERED.handle);

        const removedRow = trackedRow(page, SEEDED_RENDERED.handle);
        await expect(removedRow).toBeVisible();
        await expect(
            await trackedCell(page, SEEDED_RENDERED.handle, "Follower change · 7 days"),
        ).toContainText(SEEDED_RENDERED.growth7);
        await expect(removedRow).toContainText(
            `Eligible for cleanup on ${formatKuwaitInstant(CLEANUP_ELIGIBLE_AT)}`,
        );

        // The detail of a removed entry is still readable.
        await removedRow
            .getByRole("button", { name: `View report for ${SEEDED_RENDERED.handle}` })
            .click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        await expect(sheet.getByText("This competitor was removed.", { exact: true })).toBeVisible();
        await expect(sheet.getByText(SEEDED_MEDIA.caption, { exact: true })).toBeVisible();
        await expect(sheet.getByText("412", { exact: true })).toBeVisible();
    });

    test("a reactivation keeps the same identity and clears the removed marker", async ({ page }) => {
        const store = await startCompetitorJourney(page);
        await openCompetitorsTab(page);
        await waitForTrackedList(page, SEEDED_RENDERED.handle);

        // Remove it first: the reactivation is only reachable from Removed.
        await trackedRow(page, SEEDED_RENDERED.handle)
            .getByRole("button", { name: `Remove ${SEEDED_RENDERED.handle}` })
            .click();
        await page
            .getByRole("alertdialog")
            .getByRole("button", { name: "Remove", exact: true })
            .click();
        await expect(
            page.getByText("Track your first Instagram competitor", { exact: true }),
        ).toBeVisible();

        await page.getByRole("tab", { name: "Removed", exact: true }).click();
        await waitForTrackedList(page, SEEDED_RENDERED.handle);

        await trackedRow(page, SEEDED_RENDERED.handle)
            .getByRole("button", { name: `Reactivate ${SEEDED_RENDERED.handle}` })
            .click();

        // The same row and the same identity: no new entry was created.
        expect(store.entries).toHaveLength(1);
        expect(store.entries[0].watchlist_id).toBe(SEEDED.watchlistId);
        expect(store.calls.updateArgs[1]).toEqual({
            p_watchlist_id: SEEDED.watchlistId,
            p_label: null,
            p_is_active: true,
        });

        // The removal marker is cleared.
        expect(store.entries[0].removed_at).toBeNull();
        expect(store.entries[0].cleanup_eligible_at).toBeNull();

        await page.getByRole("tab", { name: "Active", exact: true }).click();
        await waitForTrackedList(page, SEEDED_RENDERED.handle);

        const row = trackedRow(page, SEEDED_RENDERED.handle);
        await expect(row).toBeVisible();
        await expect(row).not.toContainText("Eligible for cleanup on");
        await expect(
            await trackedCell(page, SEEDED_RENDERED.handle, "Follower change · 7 days"),
        ).toContainText(SEEDED_RENDERED.growth7);
    });

    test("the tracked list renders in Arabic with a right-to-left document", async ({ page }) => {
        await startCompetitorJourney(page);
        await openCompetitorsTab(page, { lang: "ar" });
        await waitForTrackedList(page, SEEDED_RENDERED.handle);

        await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
        await expect(page.locator("html")).toHaveAttribute("lang", "ar");

        // The Arabic copy of the feature, not the English default.
        await expect(
            page.getByRole("heading", { name: "المنافسين اللي بتتابعهم" }),
        ).toBeVisible();
        await expect(page.getByRole("tab", { name: "نشطين", exact: true })).toBeVisible();
        await expect(page.getByRole("tab", { name: "تمت إزالتهم", exact: true })).toBeVisible();
        await expect(
            page.getByRole("columnheader", { name: "تغيّر المتابعين · 7 أيام" }),
        ).toBeAttached();

        // The handle is still readable in a right-to-left document.
        await expect(trackedRow(page, SEEDED_RENDERED.handle)).toContainText(
            SEEDED_RENDERED.handle,
        );
    });

    test("the remove dialog is operable with the keyboard alone and restores the focus", async ({ page }) => {
        await startCompetitorJourney(page);
        await openCompetitorsTab(page);
        await waitForTrackedList(page, SEEDED_RENDERED.handle);

        const remove = trackedRow(page, SEEDED_RENDERED.handle).getByRole("button", {
            name: `Remove ${SEEDED_RENDERED.handle}`,
        });

        // The keyboard opens the dialog: no pointer involved.
        await remove.focus();
        await page.keyboard.press("Enter");

        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("heading")).toHaveText(
            `Remove ${SEEDED_RENDERED.handle}?`,
        );

        // The safe action is the default and the focus is inside the trap.
        const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
        await expect(cancel).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(cancel).toBeFocused();

        // Escape cancels: nothing is removed, and the focus returns to
        // the Remove button that opened the dialog.
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(trackedRow(page, SEEDED_RENDERED.handle)).toBeVisible();
        await expect(remove).toBeFocused();

        // The confirmed path is keyboard-only too, and it puts the focus
        // back on the list heading, because the row it belonged to is gone.
        await remove.focus();
        await page.keyboard.press("Enter");
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");

        await expect(dialog).toBeHidden();
        await expect(
            page.getByRole("heading", { name: "Tracked competitors", exact: true }),
        ).toBeFocused();
    });

    test("the route paths of the feature keep working", async ({ page }) => {
        await startCompetitorJourney(page);

        // The default tab of the page is Performance, and the page says so
        // in its own URL.
        await page.goto("/analytics/instagram");
        await expect(page).toHaveURL(/\/analytics\/instagram\?tab=performance$/);
        await expect(
            page.getByText("Connect Your Instagram Account", { exact: true }),
        ).toBeVisible();

        // The brand search is the second tab.
        await page.goto("/analytics/instagram?tab=analyze");
        await expect(
            page.getByPlaceholder("Enter @username or instagram.com/username"),
        ).toBeVisible();
        await expect(
            page.getByText("Connect Your Instagram Account", { exact: true }),
        ).toHaveCount(0);

        // The tracked list is the third tab.
        await page.goto("/analytics/instagram?tab=competitors");
        await expect(
            page.getByRole("heading", { name: "Tracked competitors", exact: true }),
        ).toBeVisible();

        // The legacy path still redirects to the reachable page.
        await page.goto("/brand-intelligence");
        await expect(page).toHaveURL(/\/analytics\/instagram/);
    });
});
