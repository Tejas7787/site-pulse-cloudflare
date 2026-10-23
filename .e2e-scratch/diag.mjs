import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));

// ── 1. OTP full error ───────────────────────────────────────────────────────
await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
await page.fill('input[name="email"]', "e2e-phase9c@example.com");
await page.press('input[name="email"]', "Enter");
await page.waitForTimeout(6000);
console.log("=== OTP LOGS ===");
for (const l of logs.filter((l) => /otp|sign-in|Email/i.test(l))) console.log(l.slice(0, 600));
const authBody = await page.locator("body").innerText();
console.log("=== AUTH PAGE TEXT ===");
console.log(authBody.slice(0, 600));

// ── 2. Propose panel state ──────────────────────────────────────────────────
logs.length = 0;
await page.goto(`${BASE}/auth?returnTo=%2Fdashboard`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /Continue as Guest/ }).click();
await page.waitForURL(/\/dashboard/, { timeout: 15000 });

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.fill("#website-url", "https://example.com");
await page.getByRole("button", { name: /Scan Website/ }).click();
await page.waitForURL(/\/report\/.+/, { timeout: 90000 });

const propose = page.getByRole("button", { name: /Propose fixes for this report/ });
await propose.waitFor({ timeout: 20000 });
await propose.click();
await page.waitForTimeout(10000);

const body = await page.locator("body").innerText();
const idx = body.indexOf("Fix Proposals");
console.log("=== PROPOSALS REGION ===");
console.log(idx >= 0 ? body.slice(idx, idx + 1500) : "FIX PROPOSALS REGION NOT FOUND");
console.log("=== has Connect GitHub:", /Connect GitHub/.test(body));
console.log("=== propose-related logs ===");
for (const l of logs) if (/propose|fix|plan|quota/i.test(l)) console.log(l.slice(0, 500));
await page.screenshot({ path: "shots/diag-proposals.png", fullPage: false });

await browser.close();
console.log("DIAG_DONE");
