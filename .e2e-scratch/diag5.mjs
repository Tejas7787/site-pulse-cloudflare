import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/auth?returnTo=%2Fagency`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /Continue as Guest/ }).click();
await page.waitForURL(/\/agency/, { timeout: 15000 });

await page.getByPlaceholder("Agency name (e.g. Northwind Digital)").fill("E2E Limit Probe");
await page.getByRole("button", { name: /Create workspace/ }).click();
await page.getByText(/Active clients/i).waitFor({ timeout: 15000 });

for (let i = 1; i <= 3; i += 1) {
  await page.getByPlaceholder("Client name").fill(`Probe Client ${i}`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText(`Probe Client ${i}`).first().waitFor({ timeout: 15000 });
}

const before = await page.locator("body").innerText();
const countBefore = (before.match(/Probe Client \d/g) || []).length;

await page.getByPlaceholder("Client name").fill("Probe Client 4");
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.waitForTimeout(2500);

const after = await page.locator("body").innerText();
const countAfter = [...new Set(after.match(/Probe Client \d/g) || [])].length;
console.log("client mentions before/after (unique):", countBefore, countAfter);

// All alert-ish lines (errors usually sit in red/alert styling or near the form)
const lines = after.split("\n").filter((l) => /limit|upgrade|archive|workspace|\{"code"/i.test(l));
console.log("=== matching lines after 4th submit ===");
for (const l of lines) console.log(" |", l.trim().slice(0, 250));
console.log("=== raw JSON in body:", /\{"code"/.test(after));
await page.screenshot({ path: "shots/diag5-limit.png", fullPage: false });
await browser.close();
console.log("DIAG5_DONE");
