import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

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
await page.getByText("GitHub Repair", { exact: false }).first().waitFor({ timeout: 30000 });

const body = await page.locator("body").innerText();
const idx = body.indexOf("GitHub Repair");
console.log("=== GITHUB REPAIR REGION ===");
console.log(idx >= 0 ? body.slice(idx, idx + 1800) : "NOT FOUND");
console.log("=== has Connect GitHub button:", /Connect GitHub/.test(body));
console.log("=== has Checking:", /Checking GitHub connection/.test(body));
console.log("=== has not configured:", /not configured/i.test(body));
console.log("=== has disabled on this deployment:", /disabled on this deployment/i.test(body));
await page.screenshot({ path: "shots/diag2-github.png", fullPage: false });
await browser.close();
console.log("DIAG2_DONE");
