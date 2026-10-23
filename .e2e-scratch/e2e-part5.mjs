// Phase 9C browser tests — part 5: responsive layout + navigation. Desktop
// walk-through of the nav shell, then mobile (390×844) overflow checks on the
// core pages. Also creates one monitor and saves the session state so the
// late probe poll can watch the same account's first real check.
import { chromium, devices } from "playwright";
import { appendFileSync, mkdirSync } from "fs";

const BASE = "http://localhost:5173";
mkdirSync("shots", { recursive: true });
const results = [];
function rec(id, status, detail = "") {
  results.push({ id, status, detail });
  console.log(`${status} ${id}${detail ? " :: " + detail : ""}`);
}
async function test(id, fn) {
  try {
    await fn();
  } catch (err) {
    rec(id, "FAIL", String(err).slice(0, 300));
  }
}

const browser = await chromium.launch();

// ── Desktop: nav walk-through + monitor creation (session saved for poll) ───
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/auth?returnTo=%2Fdashboard`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Continue as Guest/ }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });

  await test("desktop-nav-walkthrough", async () => {
    await page.getByRole("link", { name: /Monitoring/ }).click();
    await page.waitForURL(/\/monitors/, { timeout: 10000 });
    await page.getByText("Uptime monitors").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Back" }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 10000 });
    await page.getByRole("link", { name: /Pricing/ }).click();
    await page.waitForURL(/\/pricing/, { timeout: 10000 });
    await page.getByText("Plans & billing").waitFor({ timeout: 10000 });
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /Agency/ }).click();
    await page.waitForURL(/\/agency/, { timeout: 10000 });
    rec("desktop-nav-walkthrough", "PASS", "dashboard ⇄ monitors ⇄ pricing ⇄ agency");
  });

  await test("latepoll-monitor-created", async () => {
    await page.goto(`${BASE}/monitors`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("https://example.com").fill("https://example.com");
    await page.getByRole("button", { name: "Monitor", exact: true }).click();
    await page.getByText("example.com").first().waitFor({ timeout: 15000 });
    await ctx.storageState({ path: "session-state.json" });
    rec("latepoll-monitor-created", "PASS", "monitor created; session saved for probe poll");
  });

  await ctx.close();
}

// ── Mobile: no horizontal overflow on the core pages (390×844) ─────────────
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();

  async function assertNoOverflow(path, waitFor, name) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    if (waitFor) await waitFor().catch(() => {});
    await page.waitForTimeout(1200);
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    const overflow = metrics.scrollWidth - metrics.clientWidth;
    await page.screenshot({ path: `shots/w8-mobile${name}.png`, fullPage: true });
    if (overflow > 4) throw new Error(`horizontal overflow ${overflow}px (${JSON.stringify(metrics)})`);
  }

  await test("mobile-landing-no-overflow", async () => {
    await assertNoOverflow("/", async () => {
      await page.getByRole("button", { name: /Scan Website/ }).waitFor({ timeout: 15000 });
    }, "-landing");
    rec("mobile-landing-no-overflow", "PASS");
  });

  // Sign in for the authenticated pages on mobile.
  await page.goto(`${BASE}/auth?returnTo=%2Fdashboard`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Continue as Guest/ }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });

  await test("mobile-dashboard-no-overflow", async () => {
    await assertNoOverflow("/dashboard", async () => {
      await page.getByText("Authenticated workspace").waitFor({ timeout: 15000 });
    }, "-dashboard");
    rec("mobile-dashboard-no-overflow", "PASS");
  });

  await test("mobile-monitors-no-overflow", async () => {
    await assertNoOverflow("/monitors", async () => {
      await page.getByText("Uptime monitors").waitFor({ timeout: 15000 });
    }, "-monitors");
    rec("mobile-monitors-no-overflow", "PASS");
  });

  await test("mobile-pricing-no-overflow", async () => {
    await assertNoOverflow("/pricing", async () => {
      await page.getByText("Plans & billing").waitFor({ timeout: 15000 });
    }, "-pricing");
    rec("mobile-pricing-no-overflow", "PASS");
  });

  await test("mobile-agency-no-overflow", async () => {
    await assertNoOverflow("/agency", async () => {
      await page.getByText(/Agency workspace|Create a workspace/i).first().waitFor({ timeout: 15000 });
    }, "-agency");
    rec("mobile-agency-no-overflow", "PASS");
  });

  await ctx.close();
}

appendFileSync("results.jsonl", results.map((r) => JSON.stringify(r)).join("\n") + "\n");
await browser.close();
console.log("PART5_DONE");
