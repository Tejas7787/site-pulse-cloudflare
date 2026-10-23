import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const consoleLines = [];
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`));

const wsFrames = [];
page.on("websocket", (ws) => {
  ws.on("framereceived", (f) => {
    const payload = String(f.payload ?? "");
    if (/getConnection|github|Error|error/i.test(payload)) wsFrames.push(`RECV ${payload.slice(0, 400)}`);
  });
  ws.on("framesent", (f) => {
    const payload = String(f.payload ?? "");
    if (/getConnection|github/i.test(payload)) wsFrames.push(`SENT ${payload.slice(0, 300)}`);
  });
});

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
await page.waitForTimeout(12000);

console.log("=== WS FRAMES (github/getConnection/errors) ===");
for (const f of wsFrames.slice(0, 30)) console.log(f);
console.log("=== CONVEX console lines ===");
for (const l of consoleLines.filter((l) => /CONVEX|convex|github/i.test(l))) console.log(l);
console.log("=== github in console count:", consoleLines.filter((l) => /github/i.test(l)).length);

await browser.close();
console.log("DIAG3_DONE");
