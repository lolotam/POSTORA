import { test as base, Page } from "@playwright/test";

// Extend base test with authentication fixture
export const test = base.extend<{ authenticatedPage: Page }>({
  // Playwright passes the fixture provider as the second argument, conventionally
  // named `use` — renamed to `provide` so react-hooks/rules-of-hooks doesn't
  // mistake it for React 19's `use` hook.
  authenticatedPage: async ({ page }, provide) => {
    // Navigate to auth page
    await page.goto("/auth");

    // Wait for the page to load
    await page.waitForLoadState("networkidle");

    // Note: In a real scenario, you would:
    // 1. Fill in test credentials
    // 2. Submit the login form
    // 3. Wait for redirect to dashboard

    // For demo purposes, we'll use a test account
    // In production, use environment variables for credentials
    const testEmail = process.env.TEST_USER_EMAIL || "test@example.com";
    const testPassword = process.env.TEST_USER_PASSWORD || "testpassword123";

    // Fill login form
    await page.fill('input[placeholder="you@example.com"]', testEmail);
    await page.fill('input[type="password"]', testPassword);

    // Click sign in button
    await page.click('button:has-text("Sign In")');

    // Wait for navigation to dashboard
    await page.waitForURL("**/dashboard", { timeout: 10000 }).catch(() => {
      // If login fails, the test will proceed but may fail later
      console.log("Login may have failed - continuing with test");
    });

    await provide(page);
  },
});

export { expect } from "@playwright/test";
